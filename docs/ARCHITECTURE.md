# Architecture

`bot/` owns Telegram transport, handlers, keyboards and middleware. `modules/` owns domain use-cases. `database/` owns the pool and schema. `config/` validates environment. `shared/` contains logging.

Handlers contain no SQL. Repositories know nothing about Telegram. Services own business rules and transactions.

Registration state is persisted in MySQL. A global profile is unique by Telegram user ID. Until it exists, all actions except registration continuation/cancellation are denied server-side. Campaign entries are unique per profile and campaign; a JSON snapshot freezes profile data at entry time.
