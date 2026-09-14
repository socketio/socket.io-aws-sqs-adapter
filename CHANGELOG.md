# History

| Version                  | Release date   |
|--------------------------|----------------|
| [0.2.0](#020-2026-09-14) | September 2026 |
| [0.1.1](#011-2024-06-11) | June 2024      |
| [0.1.0](#010-2024-03-20) | March 2024     |


## [0.2.0](https://github.com/socketio/socket.io-aws-sqs-adapter/compare/0.1.1...0.2.0) (2026-09-14)


### Bug Fixes

* abort SQS polling on adapter close ([d08ec46](https://github.com/socketio/socket.io-aws-sqs-adapter/commits/d08ec46a72838b349924550f8678231ed2c00398))
* add retry delay after SQS polling errors ([d23bc03](https://github.com/socketio/socket.io-aws-sqs-adapter/commits/d23bc0322c8e449d80cc0e458793ba70d3e4b38d))
* await queue deletion in `close()` ([#6](/https://github.com/socketio/socket.io-aws-sqs-adapter/issues/6)) ([4d85d45](https://github.com/socketio/socket.io-aws-sqs-adapter/commits/4d85d45266224a4581b3e7a5881f6e7fb7b0699c))


### Features

* add options for SQS polling parameters ([c7db917](https://github.com/socketio/socket.io-aws-sqs-adapter/commits/c7db917fc3116c3b63fa8c74dca3ab54903c2de1))
* allow disabling topic creation ([#9](/https://github.com/socketio/socket.io-aws-sqs-adapter/issues/9)) ([6a15978](https://github.com/socketio/socket.io-aws-sqs-adapter/commits/6a15978b6af896f4f6f99befb717ee3116445249))
* allow overriding queue name ([#8](/https://github.com/socketio/socket.io-aws-sqs-adapter/issues/8)) ([0f8da2e](https://github.com/socketio/socket.io-aws-sqs-adapter/commits/0f8da2e53733212da10257263ade9b978ba9b3ac))


## [0.1.1](https://github.com/socketio/socket.io-aws-sqs-adapter/compare/0.1.0...0.1.1) (2024-06-11)


### Bug Fixes

* make the "opts" argument optional ([#3](https://github.com/socketio/socket.io-aws-sqs-adapter/issues/3)) ([cda5066](https://github.com/socketio/socket.io-aws-sqs-adapter/commit/cda506606e4fc4d41e7e71db2b41c81655cc6aa2))



## 0.1.0 (2024-03-20)

Initial release!

