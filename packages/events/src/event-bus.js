/**
 * EVENT BUS — one granular, hookable, watchable pub/sub primitive for all
 * of Qu V5: domain notifications (`notification.chat.mention`), structural
 * change events (`space.node.<id>.changed`), and UI events (`ui.route.
 * change`) all flow through the SAME class, on dot-namespaced topics.
 *
 * This is a merge of two ideas that lived separately in the V3 evaluation
 * branch this was ported from - `@qu/core`'s `QuEvents` (ordered,
 * fault-isolated fan-out) and `@qu/foundation`'s `HookBus` (three emit
 * modes: fire-and-forget `notify`, sequential-transform `run`, and
 * gather-results `collect`) - unified into one bus, with topics that
 * support wildcard subscription instead of exact-string-only. The
 * motivating case: a browser-notification handler wants to subscribe to
 * EVERY notification topic (`notification.**`) without the app author
 * having to explicitly register it once per concrete topic string, and
 * without the bus doing an O(n) scan of every registered pattern on every
 * `emit()` once an app has hundreds of them.
 *
 * WILDCARD SEGMENTS (matched against a topic split on '.'):
 *   - `*`  matches exactly one segment.       `chat.*` matches `chat.mention`, not `chat.a.b`.
 *   - `**` matches zero or more segments, and must be the LAST segment of
 *     a pattern (enforced at `on()` time) - `chat.**` matches `chat`,
 *     `chat.mention`, `chat.thread.reply`, everything under the prefix.
 *
 * DISPATCH IS A TRIE, NOT A REGEX SCAN: patterns are inserted segment by
 * segment into a tree (`_Node` below); `emit()` walks the CONCRETE topic's
 * segments against the tree once, following literal/`*`/`**` branches in
 * parallel, collecting every matching pattern's handlers as it goes. Cost
 * is proportional to the topic's depth and the number of DISTINCT
 * branches that can match it, not to how many patterns are registered
 * overall - subscribing a thousand unrelated topics does not slow down
 * emitting to one.
 *
 * ORDERING ACROSS PATTERNS: handlers from every matching pattern (a literal
 * match, `chat.*`, and `notification.**` might all match one topic at
 * once) are merged into ONE list and sorted by `order` (default 0, lower
 * runs first; ties keep registration order - stable sort), so "run the
 * settings gate before any delivery handler" works via `order` regardless
 * of which pattern each side subscribed with.
 */
export class EventBus {
  #root = new _Node();
  /** @type {Map<Function, {pattern: string, node: _Node, entry: object}>} Reverse index for off() by handler reference. */
  #byHandler = new Map();
  #seq = 0;

  /**
   * @param {string} pattern - Dot-namespaced topic, optionally ending in a
   *   literal segment, `*`, or `**` (only as the LAST segment).
   * @param {(payload: *, ctx: object) => *} handler
   * @param {{order?: number}} [options] - Lower order runs first (default 0).
   * @returns {() => void} Unsubscribe function.
   */
  on(pattern, handler, { order = 0 } = {}) {
    const segments = _split(pattern);
    let node = this.#root;
    let isGlobstar = false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === '**') {
        if (i !== segments.length - 1) {
          throw new Error(`EventBus.on: "**" must be the last segment of a pattern (got "${pattern}")`);
        }
        isGlobstar = true;
        break; // stays on the node reached so far - see _Node's own doc comment.
      }
      node = node.child(seg);
    }
    const entry = { handler, order, seq: this.#seq++, pattern };
    (isGlobstar ? node.globstarHandlers : node.handlers).push(entry);
    this.#byHandler.set(handler, { pattern, node, entry, isGlobstar });
    return () => this.off(pattern, handler);
  }

  /** Registers a handler that fires once, then unsubscribes itself. Same signature as `on()`. */
  once(pattern, handler, options) {
    const off = this.on(
      pattern,
      (payload, ctx) => {
        off();
        return handler(payload, ctx);
      },
      options
    );
    return off;
  }

  /** @param {string} pattern - Must match exactly what was passed to on() (same string). @param {Function} handler */
  off(pattern, handler) {
    const found = this.#byHandler.get(handler);
    if (!found || found.pattern !== pattern) return;
    const list = found.isGlobstar ? found.node.globstarHandlers : found.node.handlers;
    const idx = list.indexOf(found.entry);
    if (idx !== -1) list.splice(idx, 1);
    this.#byHandler.delete(handler);
  }

  /**
   * Runs every handler whose pattern matches `topic`, in `order`, with the
   * SAME payload (true fan-out, not a transform chain - a handler's return
   * value is ignored here). A throwing handler is caught and recorded on
   * `ctx.errors`, never aborts the rest - one broken delivery handler must
   * never take down another, or the write that triggered the emit.
   *
   * A handler may call `ctx.stop()` to prevent any handler AFTER it (in
   * `order`) from running for this emit - e.g. a settings gate at `order:
   * -100` stopping a muted topic before any delivery handler sees it.
   *
   * `ctx.topic` is always set to the CONCRETE topic emitted - a handler
   * registered on a wildcard pattern (e.g. `debug.**`) has no other way to
   * know which specific topic actually fired; this is what
   * `createDebugLogger()` (debug-logger.js) reads to print one line per
   * event without every call site having to duplicate its own topic string
   * into the payload.
   *
   * @param {string} topic - Concrete (no wildcards).
   * @param {*} payload
   * @param {object} [ctx]
   * @returns {Promise<object>} ctx, with `ctx.errors` (array), `ctx.stopped` (boolean), and `ctx.topic`.
   */
  async emit(topic, payload, ctx = {}) {
    ctx.topic = topic;
    ctx.errors = ctx.errors ?? [];
    ctx.stopped = false;
    ctx.stop = () => {
      ctx.stopped = true;
    };
    for (const { handler } of this.#match(topic)) {
      if (ctx.stopped) break;
      try {
        await handler(payload, ctx);
      } catch (err) {
        ctx.errors.push({ topic, error: err });
        console.error(`[EventBus] handler for "${topic}" threw:`, err);
      }
    }
    return ctx;
  }

  /**
   * Runs every matching handler IN PARALLEL, for side effects only -
   * return values ignored, a rejection never stops the others. Use for
   * independent delivery handlers (toast/browser/push) that don't need to
   * run in any particular order relative to each other.
   * @param {string} topic @param {*} payload
   */
  async notify(topic, payload) {
    await Promise.all(
      this.#match(topic).map(async ({ handler }) => {
        try {
          await handler(payload);
        } catch (err) {
          console.error(`[EventBus] notify handler for "${topic}" threw:`, err);
        }
      })
    );
  }

  /**
   * Runs every matching handler in order, GATHERING return values into one
   * flat array (a handler returning nothing contributes nothing; an array
   * return is spread, not nested). Use when the caller wants ANSWERS back
   * (e.g. "who should be notified about this"), not a fire-and-forget
   * side effect or a shared-payload transform.
   * @param {string} topic @param {*} payload
   * @returns {Promise<Array<*>>}
   */
  async collect(topic, payload) {
    const out = [];
    for (const { handler } of this.#match(topic)) {
      try {
        const result = await handler(payload);
        if (result !== undefined) for (const item of [].concat(result)) out.push(item);
      } catch (err) {
        console.error(`[EventBus] collect handler for "${topic}" threw:`, err);
      }
    }
    return out;
  }

  /**
   * Runs every matching handler SEQUENTIALLY, each seeing the payload as
   * most recently patched by the handler before it. A handler may return
   * an object, shallow-merged into the running payload; returning nothing
   * leaves it unchanged. Use for transformations where order and visibility
   * of earlier patches both matter (e.g. "let every contributor add a field
   * before this message is sent").
   * @param {string} topic @param {object} payload
   * @returns {Promise<object>} The final, merged payload.
   */
  async run(topic, payload) {
    let current = payload;
    for (const { handler } of this.#match(topic)) {
      const patch = await handler(current);
      if (patch !== undefined) current = { ...current, ...patch };
    }
    return current;
  }

  /** @returns {number} How many handlers currently have a pattern that would match `topic`. */
  listenerCount(topic) {
    return this.#match(topic).length;
  }

  /** Walks the trie for `topic`'s segments, returns every matching pattern's handlers merged and sorted by (order, registration sequence). */
  #match(topic) {
    const segments = _split(topic);
    const out = [];
    this.#root.collectMatches(segments, 0, out);
    out.sort((a, b) => a.order - b.order || a.seq - b.seq);
    return out;
  }
}

function _split(topic) {
  if (!topic || typeof topic !== 'string') throw new Error(`EventBus: topic/pattern must be a non-empty string, got ${JSON.stringify(topic)}`);
  return topic.split('.');
}

/** One trie node: literal children by segment name, plus an optional `*`-child and a `**` handler list (always a match for anything from here on). */
class _Node {
  /** @type {Map<string, _Node>} */
  literal = new Map();
  star = null;
  /** @type {Array<object>} Handlers registered with a pattern ending in "**" at this node - match this node AND everything under it. */
  globstarHandlers = [];
  /** @type {Array<object>} Handlers registered with a pattern ending EXACTLY at this node (no wildcard remainder). */
  handlers = [];

  /** `on('a.**', h)`'s "**" segment is handled specially in `on()` itself (pushed straight to `globstarHandlers`, see there) - `child()` is only ever called with a literal segment or `*`. */
  child(segment) {
    if (segment === '*') return (this.star ??= new _Node());
    if (!this.literal.has(segment)) this.literal.set(segment, new _Node());
    return this.literal.get(segment);
  }

  collectMatches(segments, i, out) {
    // "**" registered here matches this node and everything under it, regardless of how many segments remain.
    out.push(...this.globstarHandlers);
    if (i === segments.length) {
      out.push(...this.handlers);
      return;
    }
    const seg = segments[i];
    const literalChild = this.literal.get(seg);
    if (literalChild) literalChild.collectMatches(segments, i + 1, out);
    if (this.star) this.star.collectMatches(segments, i + 1, out);
  }
}
