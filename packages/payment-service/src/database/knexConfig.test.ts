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
import { expect } from "chai";

import {
  getMigrationConfig,
  getReaderConfig,
  getWriterConfig,
} from "./knexConfig";

describe("knexConfig", () => {
  it("applies statement/idle timeouts on app (writer/reader) connections", () => {
    for (const config of [getWriterConfig(), getReaderConfig()]) {
      const afterCreate = (config.pool as { afterCreate?: unknown })
        .afterCreate;
      expect(afterCreate, "app pool must have an afterCreate hook").to.be.a(
        "function",
      );

      let executedSql = "";
      let doneCalled = false;
      (
        afterCreate as (
          conn: { query: (sql: string, cb: (e: null) => void) => void },
          done: (e: null, conn: unknown) => void,
        ) => void
      )(
        {
          query: (sql, cb) => {
            executedSql = sql;
            cb(null);
          },
        },
        () => {
          doneCalled = true;
        },
      );

      expect(executedSql).to.contain("statement_timeout");
      expect(executedSql).to.contain("idle_in_transaction_session_timeout");
      expect(doneCalled).to.equal(true);
    }
  });

  it("does NOT apply a statement timeout on the migration runner connection", () => {
    const migrationPool = getMigrationConfig().pool as {
      afterCreate?: unknown;
    };
    expect(migrationPool.afterCreate).to.equal(undefined);
  });

  it("honors DB_POOL_MAX for sizing", () => {
    expect((getWriterConfig().pool as { max: number }).max).to.be.a("number");
  });
});
