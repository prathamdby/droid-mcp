import { createServer } from "node:net"

import { Option, Schema } from "effect"

const AddressSchema = Schema.Struct({ port: Schema.Number })

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()

    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      Option.match(Schema.decodeUnknownOption(AddressSchema)(probe.address()), {
        onNone: () => reject(new Error("no port")),
        onSome: ({ port }) => probe.close(() => resolve(port)),
      })
    })
  })
