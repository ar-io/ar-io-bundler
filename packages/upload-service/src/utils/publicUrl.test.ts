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

import { publicUrlForRequest } from "./publicUrl";

describe("publicUrlForRequest", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.UPLOAD_SERVICE_PUBLIC_URL;
    delete process.env.UPLOAD_SERVICE_PUBLIC_HOSTS;
  });

  after(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("falls back to the default when no env is set", () => {
    expect(publicUrlForRequest({ host: "upload.ardrive.io" })).to.equal(
      "http://localhost:3001"
    );
  });

  it("falls back to UPLOAD_SERVICE_PUBLIC_URL when the allowlist is unset", () => {
    process.env.UPLOAD_SERVICE_PUBLIC_URL = "https://upload.services.ar.io";
    expect(publicUrlForRequest({ host: "upload.ardrive.io" })).to.equal(
      "https://upload.services.ar.io"
    );
  });

  it("echoes an allowlisted request host as https", () => {
    process.env.UPLOAD_SERVICE_PUBLIC_URL = "https://upload.services.ar.io";
    process.env.UPLOAD_SERVICE_PUBLIC_HOSTS =
      "upload.ardrive.io,upload.services.ar.io";
    expect(publicUrlForRequest({ host: "upload.ardrive.io" })).to.equal(
      "https://upload.ardrive.io"
    );
    expect(publicUrlForRequest({ host: "upload.services.ar.io" })).to.equal(
      "https://upload.services.ar.io"
    );
  });

  it("strips a port from the host before matching and emitting", () => {
    process.env.UPLOAD_SERVICE_PUBLIC_HOSTS = "upload.ardrive.io";
    expect(publicUrlForRequest({ host: "upload.ardrive.io:443" })).to.equal(
      "https://upload.ardrive.io"
    );
  });

  it("matches case-insensitively", () => {
    process.env.UPLOAD_SERVICE_PUBLIC_HOSTS = "upload.ardrive.io";
    expect(publicUrlForRequest({ host: "Upload.ArDrive.IO" })).to.equal(
      "https://upload.ardrive.io"
    );
  });

  it("ignores whitespace in the allowlist entries", () => {
    process.env.UPLOAD_SERVICE_PUBLIC_HOSTS =
      " upload.ardrive.io , upload.services.ar.io ";
    expect(publicUrlForRequest({ host: "upload.services.ar.io" })).to.equal(
      "https://upload.services.ar.io"
    );
  });

  it("falls back for a non-allowlisted (spoofed) host", () => {
    process.env.UPLOAD_SERVICE_PUBLIC_URL = "https://upload.services.ar.io";
    process.env.UPLOAD_SERVICE_PUBLIC_HOSTS = "upload.ardrive.io";
    expect(publicUrlForRequest({ host: "evil.example.com" })).to.equal(
      "https://upload.services.ar.io"
    );
  });

  it("falls back when the host is missing", () => {
    process.env.UPLOAD_SERVICE_PUBLIC_URL = "https://upload.services.ar.io";
    process.env.UPLOAD_SERVICE_PUBLIC_HOSTS = "upload.ardrive.io";
    expect(publicUrlForRequest({})).to.equal("https://upload.services.ar.io");
    expect(publicUrlForRequest({ host: "" })).to.equal(
      "https://upload.services.ar.io"
    );
  });
});
