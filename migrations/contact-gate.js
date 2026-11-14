'use strict';

async function up(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS telegram_contact_gate (
    telegram_user_id BIGINT NOT NULL PRIMARY KEY,
    chat_id BIGINT NOT NULL,
    accepted_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_contact_gate_accepted(accepted_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  return {ok:true,feature:'telegram-contact-gate'};
}

module.exports={up};
