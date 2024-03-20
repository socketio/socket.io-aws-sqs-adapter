# Socket.IO AWS SQS adapter

The @socket.io/aws-sqs-adapter` package allows broadcasting packets between multiple Socket.IO servers.

Unlike the existing [`socket.io-sqs`](https://github.com/thinkalpha/socket.io-sqs) package, this package supports binary payloads and dynamic namespaces.

**Table of contents**

- [Supported features](#supported-features)
- [Installation](#installation)
- [Usage](#usage)
- [Options](#options)
- [License](#license)

## Supported features

| Feature                         | `socket.io` version | Support                                        |
|---------------------------------|---------------------|------------------------------------------------|
| Socket management               | `4.0.0`             | :white_check_mark: YES (since version `0.1.0`) |
| Inter-server communication      | `4.1.0`             | :white_check_mark: YES (since version `0.1.0`) |
| Broadcast with acknowledgements | `4.5.0`             | :white_check_mark: YES (since version `0.1.0`) |
| Connection state recovery       | `4.6.0`             | :x: NO                                         |

## Installation

```
npm install @socket.io/aws-sqs-adapter
```

## Usage

```js
import { SNS } from "@aws-sdk/client-sns";
import { SQS } from "@aws-sdk/client-sqs";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/aws-sqs-adapter";

const snsClient = new SNS();
const sqsClient = new SQS();

const io = new Server({
  adapter: createAdapter(snsClient, sqsClient)
});

// wait for the creation of the SQS queue
await io.of("/").adapter.init();

io.listen(3000);
```

## Options

| Name                | Description                                                        | Default value |
|---------------------|--------------------------------------------------------------------|---------------|
| `topicName`         | The name of the SNS topic.                                         | `socket.io`   |
| `topicTags`         | The tags to apply to the new SNS topic.                            | `-`           |
| `queuePrefix`       | The prefix of the SQS queue.                                       | `socket.io`   |
| `queueTags`         | The tags to apply to the new SQS queue.                            | `-`           |
| `heartbeatInterval` | The number of ms between two heartbeats.                           | `5_000`       |
| `heartbeatTimeout`  | The number of ms without heartbeat before we consider a node down. | `10_000`      |

## License

[MIT](LICENSE)
