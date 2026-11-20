import * as PubSub from "effect/PubSub"
import * as Stream from "effect/Stream"

export interface BroadcastItem<A> {
  readonly kind: "item"
  readonly value: A
}

export interface BroadcastEnd {
  readonly kind: "end"
}

export type Broadcast<A> = BroadcastItem<A> | BroadcastEnd

/** Subscribers observe events, then complete when the producer ends. */
export const broadcast = <A>(pubsub: PubSub.PubSub<Broadcast<A>>): Stream.Stream<A> =>
  Stream.fromPubSub(pubsub).pipe(
    Stream.takeWhile((event): event is BroadcastItem<A> => event.kind === "item"),
    Stream.map((event) => event.value),
  )

export const publishItem = <A>(pubsub: PubSub.PubSub<Broadcast<A>>, value: A): void => {
  PubSub.publishUnsafe(pubsub, { kind: "item", value })
}

export const endBroadcast = <A>(pubsub: PubSub.PubSub<Broadcast<A>>): void => {
  PubSub.endUnsafe(pubsub, { kind: "end" })
}
