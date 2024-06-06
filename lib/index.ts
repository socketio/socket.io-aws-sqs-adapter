import { ClusterAdapterWithHeartbeat } from "socket.io-adapter";
import type {
  ClusterAdapterOptions,
  ClusterMessage,
  ClusterResponse,
  Offset,
  ServerId,
} from "socket.io-adapter";
import { randomBytes } from "node:crypto";
import { encode, decode } from "@msgpack/msgpack";
import type {
  CreateTopicCommandInput,
  MessageAttributeValue,
  SNS,
} from "@aws-sdk/client-sns";
import { PublishCommand } from "@aws-sdk/client-sns";
import type {
  CreateQueueCommandInput,
  Message,
  SQS,
} from "@aws-sdk/client-sqs";

const debug = require("debug")("socket.io-aws-sqs-adapter");

function randomId() {
  return randomBytes(8).toString("hex");
}

export interface AdapterOptions {
  /**
   * The name of the SNS topic.
   * @default "socket.io"
   */
  topicName?: string;
  /**
   * The tags to apply to the new SNS topic.
   */
  topicTags?: CreateTopicCommandInput["Tags"];
  /**
   * The prefix of the SQS queue.
   * @default "socket.io"
   */
  queuePrefix?: string;
  /**
   * The tags to apply to the new SQS queue.
   */
  queueTags?: CreateQueueCommandInput["tags"];
}

async function createQueue(
  snsClient: SNS,
  sqsClient: SQS,
  opts: AdapterOptions
) {
  const topicName = opts?.topicName || "socket-io";

  debug("creating topic [%s]", topicName);

  const createTopicCommandOutput = await snsClient.createTopic({
    Name: topicName,
    Tags: opts?.topicTags,
  });

  debug("topic [%s] was successfully created", topicName);

  const queueName = `${opts?.queuePrefix || "socket-io"}-${randomId()}`;

  debug("creating queue [%s]", queueName);

  const createQueueCommandOutput = await sqsClient.createQueue({
    QueueName: queueName,
    tags: opts?.queueTags,
  });

  debug("queue [%s] was successfully created", queueName);

  const queueUrl = createQueueCommandOutput.QueueUrl;
  const getQueueAttributesCommandOutput = await sqsClient.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["QueueArn"],
  });

  const topicArn = createTopicCommandOutput.TopicArn!;
  const queueArn = getQueueAttributesCommandOutput.Attributes?.QueueArn!;

  await sqsClient.setQueueAttributes({
    QueueUrl: queueUrl,
    Attributes: {
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Id: "__default_policy_ID",
        Statement: [
          {
            Sid: "__owner_statement",
            Effect: "Allow",
            Principal: "*",
            Action: "SQS:SendMessage",
            Resource: queueArn,
            Condition: {
              ArnEquals: {
                "aws:SourceArn": topicArn,
              },
            },
          },
        ],
      }),
    },
  });

  const subscribeCommandOutput = await snsClient.subscribe({
    TopicArn: createTopicCommandOutput.TopicArn,
    Protocol: "sqs",
    Endpoint: queueArn,
    Attributes: { RawMessageDelivery: "true" },
  });

  debug(
    "queue [%s] has successfully subscribed to topic [%s]",
    queueName,
    topicName
  );

  return {
    topicArn,
    queueName,
    queueUrl,
    subscriptionArn: subscribeCommandOutput.SubscriptionArn!,
  };
}

/**
 * Returns a function that will create a {@link PubSubAdapter} instance.
 *
 * @param snsClient - a client from the `@aws-sdk/client-sns` package
 * @param sqsClient - a client from the `@aws-sdk/client-sqs` package
 * @param opts - additional options
 *
 * @public
 */
export function createAdapter(
  snsClient: SNS,
  sqsClient: SQS,
  opts: AdapterOptions & ClusterAdapterOptions
) {
  let isClosed = false;
  let _topicArn: string;

  const namespaceToAdapters = new Map<string, PubSubAdapter>();

  const queueCreation = createQueue(snsClient, sqsClient, opts);

  queueCreation
    .then(async ({ topicArn, queueName, queueUrl, subscriptionArn }) => {
      _topicArn = topicArn;

      namespaceToAdapters.forEach((adapter) => {
        adapter._topicArn = topicArn;
      });

      async function poll() {
        const output = await sqsClient.receiveMessage({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10, // default 1, max 10
          WaitTimeSeconds: 5,
          MessageAttributeNames: ["All"],
        });

        if (output.Messages) {
          debug("received %d message(s)", output.Messages.length);

          output.Messages.forEach((message) => {
            if (
              message.MessageAttributes === undefined ||
              message.Body === undefined
            ) {
              debug("ignore malformed message");
              return;
            }

            const namespace = message.MessageAttributes["nsp"].StringValue;

            namespaceToAdapters.get(namespace!)?.onRawMessage(message);
          });

          await sqsClient.deleteMessageBatch({
            QueueUrl: queueUrl,
            Entries: output.Messages.map((message) => ({
              Id: message.MessageId,
              ReceiptHandle: message.ReceiptHandle,
            })),
          });
        }
      }

      while (!isClosed) {
        try {
          debug("polling for new messages");
          await poll();
        } catch (err) {
          debug("an error has occurred: %s", (err as Error).message);
        }
      }

      try {
        await Promise.all([
          sqsClient.deleteQueue({
            QueueUrl: queueUrl,
          }),
          snsClient.unsubscribe({
            SubscriptionArn: subscriptionArn,
          }),
        ]);
        debug("queue [%s] was successfully deleted", queueName);
      } catch (err) {
        debug(
          "an error has occurred while deleting the queue: %s",
          (err as Error).message
        );
      }
    })
    .catch((err) => {
      debug("an error has occurred while creating the queue: %s", err.message);
    });

  return function (nsp: any) {
    const adapter = new PubSubAdapter(nsp, snsClient, opts);
    adapter._topicArn = _topicArn;

    namespaceToAdapters.set(nsp.name, adapter);

    const defaultInit = adapter.init;

    adapter.init = () => {
      return queueCreation.then(() => {
        defaultInit.call(adapter);
      });
    };

    const defaultClose = adapter.close;

    adapter.close = () => {
      namespaceToAdapters.delete(nsp.name);

      if (namespaceToAdapters.size === 0) {
        isClosed = true;
      }

      defaultClose.call(adapter);
    };

    return adapter;
  };
}

export class PubSubAdapter extends ClusterAdapterWithHeartbeat {
  private readonly snsClient: SNS;
  public _topicArn: string = "";

  /**
   * Adapter constructor.
   *
   * @param nsp - the namespace
   * @param snsClient - an AWS SNS client
   * @param opts - additional options
   *
   * @public
   */
  constructor(
    nsp: any,
    snsClient: SNS,
    opts: AdapterOptions & ClusterAdapterOptions
  ) {
    super(nsp, opts);
    this.snsClient = snsClient;
  }

  protected doPublish(message: ClusterMessage): Promise<Offset> {
    const messageAttributes: Record<string, MessageAttributeValue> = {
      nsp: {
        DataType: "String",
        StringValue: this.nsp.name,
      },
      uid: {
        DataType: "String",
        StringValue: this.uid,
      },
    };

    // @ts-ignore
    if (message.data) {
      // no binary can be included in the body, so we include it in a message attribute
      messageAttributes.data = {
        DataType: "Binary",
        // @ts-ignore
        BinaryValue: encode(message.data),
      };
    }

    return this.snsClient
      .send(
        new PublishCommand({
          TopicArn: this._topicArn,
          Message: String(message.type),
          MessageAttributes: messageAttributes,
        })
      )
      .then();
  }

  protected doPublishResponse(
    requesterUid: ServerId,
    response: ClusterResponse
  ): Promise<void> {
    const messageAttributes: Record<string, MessageAttributeValue> = {
      nsp: {
        DataType: "String",
        StringValue: this.nsp.name,
      },
      uid: {
        DataType: "String",
        StringValue: this.uid,
      },
      requesterUid: {
        DataType: "String",
        StringValue: requesterUid,
      },
    };

    // @ts-ignore
    if (response.data) {
      messageAttributes.data = {
        DataType: "Binary",
        // @ts-ignore
        BinaryValue: encode(response.data),
      };
    }

    return this.snsClient
      .send(
        new PublishCommand({
          TopicArn: this._topicArn,
          Message: String(response.type),
          MessageAttributes: messageAttributes,
        })
      )
      .then();
  }

  public onRawMessage(rawMessage: Message) {
    if (
      rawMessage.MessageAttributes === undefined ||
      rawMessage.Body === undefined
    ) {
      debug("ignore malformed message");
      return;
    }

    if (rawMessage.MessageAttributes["uid"]?.StringValue === this.uid) {
      debug("ignore message from self");
      return;
    }

    const requesterUid =
      rawMessage.MessageAttributes["requesterUid"]?.StringValue;
    if (requesterUid && requesterUid !== this.uid) {
      debug("ignore response for another node");
      return;
    }

    const decoded: any = {
      type: parseInt(rawMessage.Body, 10),
      nsp: rawMessage.MessageAttributes["nsp"]?.StringValue,
      uid: rawMessage.MessageAttributes["uid"]?.StringValue,
    };

    if (rawMessage.MessageAttributes["data"]) {
      decoded.data = decode(rawMessage.MessageAttributes["data"].BinaryValue!);
    }

    debug("received %j", decoded);

    if (requesterUid) {
      this.onResponse(decoded as ClusterResponse);
    } else {
      this.onMessage(decoded as ClusterMessage);
    }
  }
}
