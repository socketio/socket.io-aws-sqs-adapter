import { ClusterAdapterWithHeartbeat } from "socket.io-adapter";
import type {
  Adapter,
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
   * The ARN of a preexisting SNS topic to reuse instead of creating a new one.
   */
  topicArn?: string;
  /**
   * The name of the SNS topic. Ignored if `topicArn` is provided.
   * @default "socket-io"
   */
  topicName?: string;
  /**
   * The tags to apply to the new SNS topic. Ignored if `topicArn` is provided.
   */
  topicTags?: CreateTopicCommandInput["Tags"];
  /**
   * A function used to generate the SQS queue name from its random ID.
   *
   * @example
   * const queueName = (randomId: string) => `my_prefix_${randomId}`,
   */
  queueName?: (id: string) => string;
  /**
   * The prefix of the SQS queue. Ignored if `queueName` is provided.
   * @default "socket-io"
   */
  queuePrefix?: string;
  /**
   * The tags to apply to the new SQS queue.
   */
  queueTags?: CreateQueueCommandInput["tags"];
  /**
   * The maximum number of messages to return.
   * The value must be between 1 and 10.
   *
   * @default 10
   */
  sqsMaxNumberOfMessages?: number;
  /**
   * The duration, in seconds, for which the call waits for a message to arrive in the queue before returning.
   * The value must be between 1 and 20.
   *
   * @default 5
   */
  sqsWaitTimeSeconds?: number;
}

async function createQueue(
  snsClient: SNS,
  sqsClient: SQS,
  opts: AdapterOptions
) {
  let topicArn: string;
  if (opts.topicArn) {
    topicArn = opts.topicArn;
    debug("using existing topic [%s]", topicArn);
  } else {
    const topicName = opts.topicName || "socket-io";

    debug("creating topic [%s]", topicName);

    const createTopicCommandOutput = await snsClient.createTopic({
      Name: topicName,
      Tags: opts.topicTags,
    });

    debug("topic [%s] was successfully created", topicName);

    topicArn = createTopicCommandOutput.TopicArn!;
  }

  const queueId = randomId();
  const queueName = opts.queueName
    ? opts.queueName(queueId)
    : `${opts.queuePrefix || "socket-io"}-${queueId}`;

  debug("creating queue [%s]", queueName);

  const createQueueCommandOutput = await sqsClient.createQueue({
    QueueName: queueName,
    tags: opts.queueTags,
  });

  debug("queue [%s] was successfully created", queueName);

  const queueUrl = createQueueCommandOutput.QueueUrl;
  const getQueueAttributesCommandOutput = await sqsClient.getQueueAttributes({
    QueueUrl: queueUrl,
    AttributeNames: ["QueueArn"],
  });

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
    TopicArn: topicArn,
    Protocol: "sqs",
    Endpoint: queueArn,
    Attributes: { RawMessageDelivery: "true" },
  });

  debug(
    "queue [%s] has successfully subscribed to topic [%s]",
    queueName,
    topicArn
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
  opts: AdapterOptions & ClusterAdapterOptions = {}
) {
  let isClosed = false;
  let _topicArn: string;

  const namespaceToAdapters = new Map<string, PubSubAdapter>();
  const abortController = new AbortController();

  const queueCreation = createQueue(snsClient, sqsClient, opts);

  const cleanupPromise = queueCreation
    .then(async ({ topicArn, queueName, queueUrl, subscriptionArn }) => {
      _topicArn = topicArn;

      namespaceToAdapters.forEach((adapter) => {
        adapter._topicArn = topicArn;
      });

      async function poll() {
        const output = await sqsClient.receiveMessage(
          {
            QueueUrl: queueUrl,
            MaxNumberOfMessages: opts.sqsMaxNumberOfMessages ?? 10,
            WaitTimeSeconds: opts.sqsWaitTimeSeconds ?? 5,
            MessageAttributeNames: ["All"],
          },
          {
            abortSignal: abortController.signal,
          }
        );

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
          if (isClosed) {
            break;
          }

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

    const defaultClose = (adapter as Adapter).close;

    adapter.close = async () => {
      namespaceToAdapters.delete(nsp.name);

      const shouldClose = namespaceToAdapters.size === 0;

      if (shouldClose) {
        isClosed = true;
        abortController.abort();
      }

      await defaultClose.call(adapter);

      if (shouldClose) {
        await cleanupPromise;
      }
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

    if ("data" in message && message.data) {
      // no binary can be included in the body, so we include it in a message attribute
      messageAttributes.data = {
        DataType: "Binary",
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

    if (response.data) {
      messageAttributes.data = {
        DataType: "Binary",
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
