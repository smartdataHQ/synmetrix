# Contract: Answer Mark (consumer side)

**Spec**: FR-030, SC-009, US4 scenario 7 | **Plan**: §6

What a consumer of the query endpoint can read to learn that an answer was served from an aggregate, and through what time that aggregate holds data. Requested by the dashboard work (cxs2 spec 290, section 5.1).

## The header

```text
x-synmetrix-aggregate-covered-until: 2026-11-01T00:00:00.000Z
```

| Property | Rule |
|---|---|
| Name | `x-synmetrix-aggregate-covered-until` |
| Value | The aggregate's coverage boundary (data-model.md, Terms): ISO-8601, UTC, millisecond precision, `Z` suffix. It is a value of the aggregate's time column. |
| Endpoint | `GET` and `POST /api/v1/load`, every output format (JSON, CSV, JSON-stat, Arrow, and exports). |
| Present | On a successful (2xx) response whose queries were answered from an aggregate. |
| Absent | On every response answered from the source, on every error response, and always when `AGGREGATE_ROUTING_ENABLED` is not `true`. |
| Count | At most one per response. One aggregate serves every query of a request (FR-014), so one value describes the whole answer, including a request that compares two date ranges. |
| Body | Not changed. The response body has the same content with or without the header. (The key order inside it already varies from call to call in Cube; it is not a signal.) |

## Meaning

Let `T` be the header value.

- Every row of the source with a time before `T` is in the aggregate as of its last refresh pass. A bucket that **ends at or before `T`** is complete as of that pass.
- A bucket that reaches past `T` may be missing or behind.
- `T` says nothing about how old the last refresh pass is. An aggregate without a complete pass inside its `max_staleness` is not used at all, so a marked answer is never older than that.

A consumer that holds a long-window answer and needs current numbers for recent buckets reads buckets wholly before `T` from that answer and asks for the others in a query of their own. A short window that includes now is answered from the source (FR-021) and carries no header.

## What the header is not

- Not a list of aggregates, table names or any other internal detail. Nothing else about routing is exposed to the consumer.
- Not present on `/api/v1/meta`, `/api/v1/sql` or dry runs; those return no data.
- Not available on answers over the SQL interface. Queries there are routed by the same decision (FR-018), but the protocol has no place for the mark.

## Delivery

- Set by the same response-header hook that sets `x-synmetrix-authority-revision`, from the request context the routing decision wrote to.
- Like `x-synmetrix-authority-revision`, it is not added to `Access-Control-Expose-Headers`. A consumer that reaches the endpoint through its own server-side proxy must pass the header on (the cxs2 proxy forwards a fixed list of `x-synmetrix-*` headers; this one has to be added to that list).

## Changing it

The header name and value format are a contract with consumers. A change to either is made here first and announced to the consumers named above.
