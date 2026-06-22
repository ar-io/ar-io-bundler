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
import { ArweaveSigner, createData } from "@dha-team/arbundles";
import Arweave from "arweave";
import axios from "axios";
import { expect } from "chai";
import { readFileSync } from "fs";
import { Server } from "http";
import { stub } from "sinon";

import { ArweaveGateway } from "../src/arch/arweaveGateway";
import { DataItemOffsetsDB } from "../src/arch/db/dataItemOffsets";
import { PostgresDatabase } from "../src/arch/db/postgres";
import { FileSystemObjectStore } from "../src/arch/fileSystemObjectStore";
import { TurboPaymentService } from "../src/arch/payment";
import { octetStreamContentType, receiptVersion } from "../src/constants";
import logger from "../src/logger";
import { createServer } from "../src/server";
import { JWKInterface } from "../src/types/jwkTypes";
import { W } from "../src/types/winston";
import { MultiPartUploadNotFound } from "../src/utils/errors";
import { getS3ObjectStore } from "../src/utils/objectStoreUtils";
import { verifyReceipt } from "../src/utils/verifyReceipt";
import { generateJunkDataItem, signDataItem } from "./helpers/dataItemHelpers";
import { assertExpectedHeadersWithContentLength } from "./helpers/expectations";
import {
  ethereumDataItem,
  invalidDataItem,
  localTestUrl,
  postStubDataItem,
  solanaDataItem,
  stubDataItemWithEmptyStringsForTagNamesAndValues,
  testArweaveJWK,
  validDataItem,
} from "./test_helpers";

const publicAndSigLength = 683;
const objectStore = getS3ObjectStore();

describe("Router tests", function () {
  let server: Server;

  function closeServer() {
    server.close();
    logger.info("Server closed!");
  }

  describe('generic routes"', () => {
    before(async () => {
      server = await createServer({
        getArweaveWallet: () => Promise.resolve(testArweaveJWK),
      });
    });

    after(() => {
      closeServer();
    });

    it("GET / returns arweave address, receipt version, and gateway in the body, a 200 status, and the correct content-length", async () => {
      const { status, statusText, headers, data } = await axios.get(
        localTestUrl
      );

      expect(status).to.equal(200);
      expect(statusText).to.equal("OK");

      expect(headers["content-type"]).to.equal(
        "application/json; charset=utf-8"
      );
      // Node 18→22: HTTP/1.1 keep-alive is now the default (was "close").
      expect(headers.connection).to.equal("keep-alive");

      expect(data).to.deep.equal({
        version: "0.2.0",
        addresses: {
          // cspell:disable
          arweave: "8wgRDgvYOrtSaWEIV21g0lTuWDUnTu4_iYj4hmA7PI0", //cspell:enable
        },
        freeUploadLimitBytes: 517120,
        gateway: "https://arweave.net",
        gateways: ["https://arweave.net"],
      });
    });
  });

  describe("Data Item Status GET `/v1/tx/:id/status` Route", () => {
    const testTxId = "G-i10-8jE1Kg1fDuEYGM-MWddAO9sJEKvfZNQuD3AP0";
    const database = new PostgresDatabase({});
    // The status route reads offsets from dataItemOffsetsDB.getOffset and merges
    // them into the response. Stub it (root_bundle_id intentionally mismatches
    // info.bundleId so the route excises startOffsetInRootBundle, as expected).
    const stubStatusOffset = {
      data_item_id: testTxId,
      root_bundle_id: "stubRootBundleId",
      raw_content_length: 12345,
      payload_content_type: "application/json",
      payload_data_start: 1234,
      start_offset_in_root_bundle: 999,
      parent_data_item_id: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
      start_offset_in_parent_data_item_payload: 321,
    };
    before(async function () {
      server = await createServer({
        database,
        dataItemOffsetsDB: {
          getOffset: async () => stubStatusOffset,
        } as unknown as DataItemOffsetsDB,
      });
    });

    after(() => {
      closeServer();
    });

    it("returns the expected data item status result for new data item", async () => {
      stub(database, "getDataItemInfo").resolves({
        assessedWinstonPrice: W("500"),
        status: "new",
        uploadedTimestamp: Date.now(),
        owner: "stubOwner",
      });

      const { status, data } = await axios.get(
        `${localTestUrl}/v1/tx/${testTxId}/status`
      );

      expect(status).to.equal(200);
      expect(data).to.deep.equal({
        status: "CONFIRMED",
        info: "new",
        winc: "500",
        parentDataItemId: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
        payloadContentLength: 11111,
        payloadContentType: "application/json",
        payloadDataStart: 1234,
        rawContentLength: 12345,
        startOffsetInParentDataItemPayload: 321,
      });
    });

    it("returns the expected data item status result for pending data item", async () => {
      stub(database, "getDataItemInfo").resolves({
        assessedWinstonPrice: W("500"),
        status: "pending",
        bundleId: "bundleId",
        uploadedTimestamp: Date.now(),
        owner: "stubOwner",
      });

      const { status, data } = await axios.get(
        `${localTestUrl}/v1/tx/${testTxId}/status`
      );

      expect(status).to.equal(200);
      expect(data).to.deep.equal({
        status: "CONFIRMED",
        info: "pending",
        bundleId: "bundleId",
        winc: "500",
        parentDataItemId: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
        payloadContentLength: 11111,
        payloadContentType: "application/json",
        payloadDataStart: 1234,
        rawContentLength: 12345,
        startOffsetInParentDataItemPayload: 321,
      });
    });

    it("returns the expected data item status result for permanent data item", async () => {
      stub(database, "getDataItemInfo").resolves({
        assessedWinstonPrice: W("500"),
        status: "permanent",
        bundleId: "bundleId",
        uploadedTimestamp: Date.now(),
        owner: "stubOwner",
      });

      const { status, data } = await axios.get(
        `${localTestUrl}/v1/tx/${testTxId}/status`
      );

      expect(status).to.equal(200);
      expect(data).to.deep.equal({
        status: "FINALIZED",
        bundleId: "bundleId",
        info: "permanent",
        winc: "500",
        parentDataItemId: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
        payloadContentLength: 11111,
        payloadContentType: "application/json",
        payloadDataStart: 1234,
        rawContentLength: 12345,
        startOffsetInParentDataItemPayload: 321,
      });
    });

    it("returns the expected response when data item is not found", async () => {
      const { data, status } = await axios.get(
        `${localTestUrl}/v1/tx/UNIQUEtransactionID43Characters123456789012/status`,
        {
          validateStatus: (status) => {
            return (status >= 200 && status < 300) || status === 404;
          },
        }
      );

      expect(status).to.equal(404);
      expect(data).to.deep.equal("TX doesn't exist");
    });
  });

  describe("Data Item Offsets GET `/v1/tx/:id/offsets` Route", () => {
    const database = new PostgresDatabase({});
    const testTxId = "G-i10-8jE1Kg1fDuEYGM-MWddAO9sJEKvfZNQuD3AP0";
    const testTxId2 = "zXNZ9WDw6YEdK80hVrh0cR_bMeWyRbK5I2wUBvr7r1o";
    // The offsets route reads from dataItemOffsetsDB.getOffset. Stub it per id:
    // testTxId carries parent-bundle offsets, testTxId2 carries root-bundle
    // offsets (undefined columns are dropped from the JSON response).
    const stubParentOffset = {
      raw_content_length: 54321,
      payload_content_type: "text/html",
      payload_data_start: 2345,
      parent_data_item_id: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
      start_offset_in_parent_data_item_payload: 123,
    };
    const stubRootOffset = {
      root_bundle_id: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
      start_offset_in_root_bundle: 123,
      raw_content_length: 43210,
      payload_content_type: "application/json",
      payload_data_start: 3456,
    };
    before(async function () {
      server = await createServer({
        database,
        dataItemOffsetsDB: {
          getOffset: async (id: string) =>
            id === testTxId
              ? stubParentOffset
              : id === testTxId2
              ? stubRootOffset
              : undefined,
        } as unknown as DataItemOffsetsDB,
      });

      stub(database, "getDataItemInfo").resolves({
        assessedWinstonPrice: W("500"),
        status: "new",
        uploadedTimestamp: Date.now(),
        owner: "stubOwner",
      });
    });

    after(() => {
      closeServer();
    });

    it("returns offsets into parent when present", async () => {
      const { status, data } = await axios.get(
        `${localTestUrl}/v1/tx/${testTxId}/offsets`
      );

      expect(status).to.equal(200);
      expect(data).to.deep.equal({
        parentDataItemId: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
        payloadContentLength: 51976,
        payloadContentType: "text/html",
        payloadDataStart: 2345,
        rawContentLength: 54321,
        startOffsetInParentDataItemPayload: 123,
      });
    });

    it("returns offsets into root tx when present", async () => {
      const { status, data } = await axios.get(
        `${localTestUrl}/v1/tx/${testTxId2}/offsets`
      );

      expect(status).to.equal(200);
      expect(data).to.deep.equal({
        rootBundleId: "uMguurlEh9a7MKYiauKGlbxG6OjP2xaGmWa1-vrHVh8",
        startOffsetInRootBundle: 123,
        payloadContentLength: 39754,
        payloadContentType: "application/json",
        payloadDataStart: 3456,
        rawContentLength: 43210,
      });
    });

    it("returns the expected response when data item is not found", async () => {
      const { data, status } = await axios.get(
        `${localTestUrl}/v1/tx/UNIQUEtransactionID43Characters123456789012/status`,
        {
          validateStatus: (status) => {
            return (status >= 200 && status < 300) || status === 404;
          },
        }
      );

      expect(status).to.equal(404);
      expect(data).to.deep.equal("TX doesn't exist");
    });
  });

  describe("Data Item POST `/v1/tx` Route", () => {
    const paymentService = new TurboPaymentService();

    const arweaveGateway = new ArweaveGateway({
      endpoint: new URL("http://fake.com"),
    });

    let receiptSigningWallet: JWKInterface;
    beforeEach(() => {
      stub(arweaveGateway, "getCurrentBlockHeight").resolves(500);
    });

    before(async () => {
      receiptSigningWallet = await Arweave.crypto.generateJWK();
    });

    describe("with a default Koa server", () => {
      let blocklistedJWK: JWKInterface;
      before(async function () {
        blocklistedJWK = JSON.parse(
          readFileSync(
            // cspell:disable
            `tests/stubFiles/blocklistedWallet.xnbLpqfiRIInqrxkhV7M-iSr8YUtm9aoezGjSnXnOFo.json`, // cspell:enable
            { encoding: "utf-8" }
          )
        );

        server = await createServer({
          paymentService,
          getArweaveWallet: () => Promise.resolve(receiptSigningWallet),
          arweaveGateway,
        });
      });

      after(() => {
        closeServer();
      });

      describe("with stubbed successful reserve and check balance methods", () => {
        beforeEach(() => {
          stub(paymentService, "reserveBalanceForData").resolves({
            costOfDataItem: W("500"),
            isReserved: true,
            walletExists: true,
          });
          stub(paymentService, "checkBalanceForData").resolves({
            bytesCostInWinc: W("500"),
            userHasSufficientBalance: true,
            userBalanceInWinc: W("1000"),
          });
        });

        it("returns the expected data result, a 200 status, the correct content-length, and the data item exists on disk with the correct byte size when signed with an Arweave wallet", async () => {
          const { status, data } = await postStubDataItem(validDataItem);

          expect(status).to.equal(200);

          const {
            id,
            owner,
            dataCaches,
            deadlineHeight,
            fastFinalityIndexes,
            public: pubKey,
            signature,
            timestamp,
            version,
            winc,
          } = data;
          // cspell:disable
          expect(id).to.equal("QpmY8mZmFEC8RxNsgbxSV6e36OF6quIYaPRKzvUco0o"); // cspell:enable
          expect(owner).to.equal("J40R1BgFSI1_7p25QW49T7P46BePJJnlDrsFGY1YWbM");
          expect(dataCaches).to.deep.equal(["arweave.net"]);
          expect(deadlineHeight).to.equal(700);
          expect(fastFinalityIndexes).to.deep.equal([]);
          expect(pubKey).to.equal(receiptSigningWallet.n);
          expect(signature).to.have.length(publicAndSigLength);
          // expect timestamp to be time since UNIX in MS (13 digits until Year 2038)
          expect(timestamp.toString()).to.have.length(13);
          expect(version).to.equal(receiptVersion);
          expect(winc).to.equal("500");

          expect(await verifyReceipt(data)).to.be.true;
          expect(
            await objectStore.getObjectByteCount(`raw-data-item/${id}`)
          ).to.equal(1115);
        });

        it("returns the expected data result with a data item that contains empty tag names and values", async () => {
          const { status, data } = await postStubDataItem(
            stubDataItemWithEmptyStringsForTagNamesAndValues
          );

          expect(status).to.equal(200);

          const { id, owner } = data;

          expect(await verifyReceipt(data)).to.be.true;

          expect(id).to.equal("hSIHAdxTDUpW9oJb26nb2zhQkJn3yNBtTakMOwJuXC0"); // cspell:disable
          expect(owner).to.equal("jaxl_dxqJ00gEgQazGASFXVRvO4h-Q0_vnaLtuOUoWU"); // cspell:enable

          expect(
            await objectStore.getObjectByteCount(`raw-data-item/${id}`)
          ).to.equal(2325);
        });

        it("with a data item signed by a non allow listed wallet with balance", async function () {
          const tags = [{ name: "test", value: "value" }];
          const dataItem = await signDataItem(
            generateJunkDataItem(512, receiptSigningWallet, tags),
            receiptSigningWallet
          );

          const { data } = await postStubDataItem(dataItem);
          expect(await verifyReceipt(data)).to.be.true;

          expect(data).to.have.property("id");
          expect(data).to.have.property("owner");
          expect(data.dataCaches).to.deep.equal(["arweave.net"]);
        });

        it("returns the expected result for an address on the block list", async () => {
          const dataItem = await signDataItem(
            generateJunkDataItem(512, blocklistedJWK, [
              { name: "test", value: "value" },
            ]),
            blocklistedJWK
          );

          const { status, statusText, headers, data } = await postStubDataItem(
            dataItem
          );

          expect(status).to.equal(403);
          assertExpectedHeadersWithContentLength(headers, 9);

          const expectedData = "Forbidden";

          expect(statusText).to.equal(expectedData);
          expect(data).to.equal(expectedData);
        });

        it("returns the expected result for an empty data item", async () => {
          const signer = new ArweaveSigner(receiptSigningWallet);
          const createdDataItem = createData("", signer, {});
          await createdDataItem.sign(signer);

          const { data, status } = await axios.post(
            `${localTestUrl}/v1/tx`,
            createdDataItem.getRaw(),
            { headers: { ["Content-Type"]: octetStreamContentType } }
          );
          expect(await verifyReceipt(data)).to.be.true;

          expect(status).to.equal(200);
          expect(data.id).to.equal(createdDataItem.id);
        });

        it("returns the expected data result, a 200 status, the correct content-length, and the data item exists on disk with the correct byte size when signed with a Solana wallet", async () => {
          const { status, data } = await postStubDataItem(solanaDataItem);

          expect(status).to.equal(200);

          // cspell:disable
          const id = "35jbLhCGEfXLWe2H3VZr2i7f610kwP8Nkw-bFfx14-E";
          const owner = "VrRCYEai_2IveGr0lCiivqLGqenh4wpBnfZNgL-FtWY"; // cspell:enable

          expect(data.id).to.equal(id);
          expect(data.owner).to.equal(owner);
          expect(await verifyReceipt(data)).to.be.true;

          expect(
            await objectStore.getObjectByteCount(`raw-data-item/${id}`)
          ).to.equal(211);
        });

        it("returns the expected data result, a 200 status, the correct content-length, and the data item exists on disk with the correct byte size when signed with an Ethereum wallet", async () => {
          const { status, data } = await postStubDataItem(ethereumDataItem);

          expect(status).to.equal(200);

          // cspell:disable
          const id = "7j-sF0lsslGVZ8lhEGXe5CtueB4iRYM3_oZ9m4GY_40";
          const owner = "xsi06LVwuRe2SaNFo0Yc1UtF3GSyi-GtzUtTkjLXrEw"; // cspell:enable

          expect(data.id).to.equal(id);
          expect(data.owner).to.equal(owner);
          expect(await verifyReceipt(data)).to.be.true;

          expect(
            await objectStore.getObjectByteCount(`raw-data-item/${id}`)
          ).to.equal(245);
        });

        it("with an invalid data item returns an error response", async () => {
          const { status, statusText, headers, data } = await postStubDataItem(
            invalidDataItem
          );

          expect(status).to.equal(400);
          assertExpectedHeadersWithContentLength(headers, 18);

          const expectedData = "Invalid Data Item!";

          expect(statusText).to.equal(expectedData);
          expect(data).to.equal(expectedData);
        });

        it.skip("returns the expected error response when submitting a duplicated data item", async () => {
          await postStubDataItem(
            readFileSync("tests/stubFiles/anotherStubDataItem")
          );

          const { status, statusText, headers, data } = await postStubDataItem(
            readFileSync("tests/stubFiles/anotherStubDataItem")
          );

          expect(status).to.equal(202);
          assertExpectedHeadersWithContentLength(headers, 104);

          const expectedData = // cspell:disable
            "Data item with ID PPqimlPSz890fAufmEs7XnpReEq_o70FvJvz-Leiw1A has already been uploaded to this service!"; // cspell:enable

          expect(statusText).to.equal(expectedData);
          expect(data).to.equal(expectedData);
        });

        it("with the wrong content type in the headers returns an error response", async () => {
          const { status, statusText, headers, data } = await postStubDataItem(
            validDataItem,
            { "Content-Type": "application/json" }
          );

          expect(status).to.equal(400);
          assertExpectedHeadersWithContentLength(headers, 20);

          const expectedData = "Invalid Content Type";

          expect(statusText).to.equal(expectedData);
          expect(data).to.equal(expectedData);
        });

        it("with an invalid data item and 0 cost it does not refund balance", async () => {
          const refundSpy = stub(
            paymentService,
            "refundBalanceForData"
          ).resolves();

          const { status, statusText, headers, data } = await postStubDataItem(
            invalidDataItem
          );

          // Refund balance was not called
          expect(refundSpy.called).to.be.false;

          expect(status).to.equal(400);
          assertExpectedHeadersWithContentLength(headers, 18);

          const expectedData = "Invalid Data Item!";

          expect(statusText).to.equal(expectedData);
          expect(data).to.equal(expectedData);
        });
      });

      // The no-X-PAYMENT path now calls checkBalanceForData (not
      // reserveBalanceForData). When the user lacks balance, the route returns
      // HTTP 402 with x402 payment requirements (from getX402PriceQuote), per
      // src/routes/dataItemPost.ts ~lines 449-518. Updated to reflect that.
      it("when balance is insufficient returns 402 with x402 payment requirements", async () => {
        const tags = [{ name: "test", value: "value" }];
        const dataItem = await signDataItem(
          generateJunkDataItem(512, receiptSigningWallet, tags),
          receiptSigningWallet
        );

        stub(paymentService, "checkBalanceForData").resolves({
          bytesCostInWinc: W("500"),
          userBalanceInWinc: W("20"),
          userHasSufficientBalance: false,
        });
        stub(paymentService, "getX402PriceQuote").resolves({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base-sepolia",
              maxAmountRequired: "1000",
              asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
              payTo: "0x0000000000000000000000000000000000000000",
              timeout: { validBefore: Math.floor(Date.now() / 1000) + 300 },
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        });
        const { status, data, headers } = await postStubDataItem(dataItem);

        expect(status).to.equal(402);
        expect(headers["x-payment-required"]).to.equal("x402-1");
        expect(data).to.have.property("x402Version", 1);
        expect(data).to.have.property("accepts");
        expect(data.accepts[0]).to.have.property("scheme");
        expect(data.accepts[0]).to.have.property("payTo");
      });

      it("with a data item signed by a non allow listed wallet without balance", async () => {
        const tags = [{ name: "test", value: "value" }];
        const dataItem = await signDataItem(
          generateJunkDataItem(512, receiptSigningWallet, tags),
          receiptSigningWallet
        );

        stub(paymentService, "checkBalanceForData").resolves({
          bytesCostInWinc: W("500"),
          userBalanceInWinc: W("20"),
          userHasSufficientBalance: false,
        });
        // Without a getX402PriceQuote stub the route hits the real (empty-URL)
        // payment call and 503s; the current insufficient-balance behavior is a
        // 402 with x402 requirements, so stub the quote to assert that.
        stub(paymentService, "getX402PriceQuote").resolves({
          x402Version: 1,
          accepts: [
            {
              scheme: "exact",
              network: "base-sepolia",
              maxAmountRequired: "1000",
              asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
              payTo: "0x0000000000000000000000000000000000000000",
              timeout: { validBefore: Math.floor(Date.now() / 1000) + 300 },
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        });
        const { status, data, headers } = await postStubDataItem(dataItem);

        expect(status).to.equal(402);
        expect(headers["x-payment-required"]).to.equal("x402-1");
        expect(data).to.have.property("x402Version", 1);
        expect(data.accepts[0]).to.have.property("payTo");
      });
    });

    describe("with a Koa server stubbed with a payment service that allows ARFS data", () => {
      const paymentService = new TurboPaymentService(true);
      before(async () => {
        server = await createServer({
          paymentService,
          getArweaveWallet: () => Promise.resolve(receiptSigningWallet),
          arweaveGateway,
        });
      });

      after(() => {
        closeServer();
      });

      it("with a data item smaller than 100KiB signed by a non allow listed wallet and ALLOW_ARFS_DATA set to 'true' returns the expected successful response", async () => {
        const { status, data } = await postStubDataItem(
          readFileSync("tests/stubFiles/stubDataItemFromNonAllowListedWallet")
        );

        expect(status).to.equal(200);

        // cspell:disable
        const id = "4fQZvrmOiRCRIvm_DdtN-EokUKz9DVuFRi1ajtjDMOI";
        const owner = "jaxl_dxqJ00gEgQazGASFXVRvO4h-Q0_vnaLtuOUoWU"; // cspell:enable

        expect(data.id).to.equal(id);
        expect(data.owner).to.equal(owner);
        expect(await verifyReceipt(data)).to.be.true;

        expect(
          await objectStore.getObjectByteCount(`raw-data-item/${id}`)
        ).to.equal(1464);
      });
    });
  });

  describe("Multipart Upload Status GET `/chunks/:token/:uploadId/status` Route", () => {
    const objectStore = new FileSystemObjectStore();
    const database = new PostgresDatabase({});
    before(async () => {
      server = await createServer({
        objectStore,
        database,
        getArweaveWallet: () => Promise.resolve(testArweaveJWK),
      });
    });

    after(() => {
      closeServer();
    });

    it("should return 404 when the uploadId is not found", async () => {
      const response = await axios.get(
        `${localTestUrl}/chunks/arweave/stubUploadId/status`,
        {
          validateStatus: () => true,
        }
      );
      expect(response.status).to.equal(404);
    });

    it("should return 200 with status message 'ASSEMBLING' for a fresh uploadId", async () => {
      stub(objectStore, "createMultipartUpload").resolves("foo");

      // 0 byte count signals that the user hasn't called finalize yet, thus assembly is not yet complete
      stub(objectStore, "getObjectByteCount").resolves(0);

      const newUploadResponse = await axios.get(
        `${localTestUrl}/chunks/arweave/-1/-1`,
        {
          validateStatus: () => true,
          // createMultiPartUpload sleeps ~250ms server-side before responding,
          // which leaves the keep-alive socket in a state where reusing it for
          // the immediately-following status GET hits Node's well-known
          // keep-alive ECONNRESET race. Disable connection reuse so each request
          // uses a fresh socket. (Test-client transport detail only.)
          headers: { Connection: "close" },
        }
      );
      const uploadId = newUploadResponse.data.id;
      const response = await axios.get(
        `${localTestUrl}/chunks/arweave/${uploadId}/status`,
        {
          validateStatus: () => true,
          headers: { Connection: "close" },
        }
      );
      expect(response.status).to.equal(200);
      expect(response.data.status).to.equal("ASSEMBLING");
      expect(Math.abs(Date.now() - response.data.timestamp)).to.be.lessThan(
        3000
      );
    });

    it("should return 200 with status message 'VALIDATING' for an uploaded but not yet validated uploadId", async () => {
      stub(objectStore, "createMultipartUpload").resolves("bar");

      // 0 byte count signals that the user hasn't called finalize yet, thus assembly is not yet complete
      stub(objectStore, "getObjectByteCount").resolves(1);

      const newUploadResponse = await axios.get(
        `${localTestUrl}/chunks/arweave/-1/-1`,
        {
          validateStatus: () => true,
          // See ASSEMBLING test: avoid the keep-alive reuse ECONNRESET race.
          headers: { Connection: "close" },
        }
      );
      const uploadId = newUploadResponse.data.id;
      const response = await axios.get(
        `${localTestUrl}/chunks/arweave/${uploadId}/status`,
        {
          validateStatus: () => true,
          headers: { Connection: "close" },
        }
      );
      expect(response.status).to.equal(200);
      expect(response.data.status).to.equal("VALIDATING");
      expect(Math.abs(Date.now() - response.data.timestamp)).to.be.lessThan(
        3000
      );
    });

    it("should return 200 with status message 'FINALIZING' for a validated but not yet finalized uploadId", async () => {
      stub(database, "getInflightMultiPartUpload").rejects(
        new MultiPartUploadNotFound("baz")
      );
      stub(database, "getFinalizedMultiPartUpload").resolves({
        uploadId: "baz",
        uploadKey: "stubUploadKey",
        createdAt: "123",
        expiresAt: "123",
        finalizedAt: "123",
        dataItemId: "stubDataItemId",
        etag: "stubEtag",
      });
      stub(database, "getDataItemInfo").resolves(undefined);

      const response = await axios.get(
        `${localTestUrl}/chunks/arweave/baz/status`,
        {
          validateStatus: () => true,
        }
      );
      expect(response.status).to.equal(200);
      expect(response.data.status).to.equal("FINALIZING");
      expect(Math.abs(Date.now() - response.data.timestamp)).to.be.lessThan(
        3000
      );
    });

    it("should return 200 with status message 'FINALIZED' for a validated and finalized uploadId", async () => {
      stub(database, "getInflightMultiPartUpload").rejects(
        new MultiPartUploadNotFound("baz")
      );
      stub(database, "getFinalizedMultiPartUpload").resolves({
        uploadId: "baz",
        uploadKey: "stubUploadKey",
        createdAt: "123",
        expiresAt: "123",
        finalizedAt: "123",
        dataItemId: "stubDataItemId",
        etag: "stubEtag",
      });
      stub(database, "getDataItemInfo").resolves({
        status: "new",
        assessedWinstonPrice: W("0"),
        uploadedTimestamp: 123,
        owner: "stubOwner",
      });

      const response = await axios.get(
        `${localTestUrl}/chunks/arweave/baz/status`,
        {
          validateStatus: () => true,
        }
      );
      expect(response.status).to.equal(200);
      expect(response.data.status).to.equal("FINALIZED");
      expect(Math.abs(Date.now() - response.data.timestamp)).to.be.lessThan(
        3000
      );
    });
  });
});
