/**
 * Copyright (C) 2022-2024 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // Create x402_payment_transaction table
  await knex.schema.createTable("x402_payment_transaction", (table) => {
    table.uuid("id").primary();
    table.string("user_address", 255).notNullable().index();
    table.string("user_address_type", 50).notNullable();
    table.string("tx_hash", 66).notNullable().unique();
    table.string("network", 50).notNullable();
    table.string("token_address", 42).notNullable();
    table.string("usdc_amount", 100).notNullable(); // Store as string to avoid precision loss
    table.string("winc_amount", 100).notNullable(); // Store as string
    table
      .enum("mode", ["payg", "topup", "hybrid"], {
        useNative: true,
        enumName: "x402_payment_mode",
      })
      .notNullable();
    table.string("data_item_id", 43).nullable().index();
    table.string("declared_byte_count", 100).nullable();
    table.string("actual_byte_count", 100).nullable();
    table
      .enum(
        "status",
        ["pending_validation", "confirmed", "refunded", "fraud_penalty"],
        {
          useNative: true,
          enumName: "x402_payment_status",
        },
      )
      .notNullable()
      .defaultTo("pending_validation");
    table.timestamp("paid_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("finalized_at").nullable();
    table.string("refund_winc", 100).nullable();
    table.string("payer_address", 42).notNullable().index();

    // Indexes for common queries
    table.index(["network", "paid_at"]);
    table.index(["status", "paid_at"]);
    table.index(["user_address", "paid_at"]);
  });

  // Create x402_payment_reservation table
  await knex.schema.createTable("x402_payment_reservation", (table) => {
    table.string("data_item_id", 43).primary();
    table
      .uuid("x402_payment_id")
      .notNullable()
      .references("id")
      .inTable("x402_payment_transaction")
      .onDelete("CASCADE");
    table.string("winc_reserved", 100).notNullable();
    table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
    table.timestamp("expires_at").notNullable();

    // Index for cleanup of expired reservations
    table.index("expires_at");
    table.index("x402_payment_id");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("x402_payment_reservation");
  await knex.schema.dropTableIfExists("x402_payment_transaction");
  await knex.raw("DROP TYPE IF EXISTS x402_payment_status");
  await knex.raw("DROP TYPE IF EXISTS x402_payment_mode");
}
