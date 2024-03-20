import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { Server, Socket as ServerSocket } from "socket.io";
import { io as ioc, Socket as ClientSocket } from "socket.io-client";
import { createAdapter } from "../lib";
import { SNS } from "@aws-sdk/client-sns";
import { SQS } from "@aws-sdk/client-sqs";

export function times(count: number, fn: () => void) {
  let i = 0;
  return () => {
    i++;
    if (i === count) {
      fn();
    }
  };
}

export function sleep(duration: number) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}

export function shouldNotHappen(done: (err?: Error) => void) {
  return () => done(new Error("should not happen"));
}

interface TestContext {
  servers: Server[];
  serverSockets: ServerSocket[];
  clientSockets: ClientSocket[];
  cleanup: () => void;
  ports: number[];
}

export function setup() {
  const servers: Server[] = [];
  const serverSockets: ServerSocket[] = [];
  const clientSockets: ClientSocket[] = [];
  const ports: number[] = [];

  const snsClient = new SNS();
  const sqsClient = new SQS();

  return new Promise<TestContext>(async (resolve) => {
    for (let i = 1; i <= 3; i++) {
      const httpServer = createServer();
      const io = new Server(httpServer, {
        adapter: createAdapter(snsClient, sqsClient, {}),
      });

      httpServer.listen(() => {
        const port = (httpServer.address() as AddressInfo).port;
        const clientSocket = ioc(`http://localhost:${port}`);

        io.on("connection", async (socket) => {
          clientSockets.push(clientSocket);
          serverSockets.push(socket);
          servers.push(io);
          ports.push(port);
          if (servers.length === 3) {
            await io.of("/").adapter.init();

            await sleep(1000);

            resolve({
              servers,
              serverSockets,
              clientSockets,
              ports,
              cleanup: () => {
                servers.forEach((server) => server.close());
                clientSockets.forEach((socket) => socket.disconnect());
              },
            });
          }
        });
      });
    }
  });
}
