"use strict";

// We need to reload adminAuth fresh for each test because the module caches
// ADMIN_API_KEY at load time from process.env.
function loadAdminAuth(key) {
  jest.resetModules();
  if (key !== undefined) {
    process.env.ADMIN_API_KEY = key;
  } else {
    delete process.env.ADMIN_API_KEY;
  }
  return require("../middleware/adminAuth").adminAuth;
}

function makeReq(overrides = {}) {
  return {
    headers: {},
    query: {},
    ip: "127.0.0.1",
    path: "/api/admin/test",
    method: "GET",
    ...overrides,
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe("adminAuth – ADMIN_API_KEY not configured", () => {
  let adminAuth;

  beforeEach(() => {
    adminAuth = loadAdminAuth("");
  });

  test("returns 503 when key env var is empty", () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(next).not.toHaveBeenCalled();
  });

  test("response body has success:false", () => {
    const res = makeRes();
    adminAuth(makeReq(), res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });
});

describe("adminAuth – valid key via header", () => {
  const SECRET = "super-secret-key-12345";
  let adminAuth;

  beforeEach(() => {
    adminAuth = loadAdminAuth(SECRET);
  });

  test("calls next() when correct key is in X-Admin-Key header", () => {
    const req = makeReq({ headers: { "x-admin-key": SECRET } });
    const res = makeRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test("accepts key with surrounding whitespace (trim)", () => {
    const req = makeReq({ headers: { "x-admin-key": `  ${SECRET}  ` } });
    const res = makeRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("adminAuth – valid key via query param", () => {
  const SECRET = "query-param-secret";
  let adminAuth;

  beforeEach(() => {
    adminAuth = loadAdminAuth(SECRET);
  });

  test("calls next() when correct key is in ?adminKey query param", () => {
    const req = makeReq({ query: { adminKey: SECRET } });
    const res = makeRes();
    const next = jest.fn();

    adminAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("adminAuth – invalid key", () => {
  const SECRET = "real-secret-abc";
  let adminAuth;

  beforeEach(() => {
    adminAuth = loadAdminAuth(SECRET);
  });

  test("returns 401 when no key is provided", () => {
    const res = makeRes();
    const next = jest.fn();
    adminAuth(makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 when wrong key is in header", () => {
    const req = makeReq({ headers: { "x-admin-key": "wrong-key" } });
    const res = makeRes();
    const next = jest.fn();
    adminAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 when wrong key is in query", () => {
    const req = makeReq({ query: { adminKey: "bad" } });
    const res = makeRes();
    const next = jest.fn();
    adminAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("response body has success:false on 401", () => {
    const res = makeRes();
    adminAuth(makeReq({ headers: { "x-admin-key": "wrong" } }), res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false })
    );
  });

  test("header key takes precedence over query param when both present", () => {
    const req = makeReq({
      headers: { "x-admin-key": "wrong-header" },
      query: { adminKey: SECRET },
    });
    const res = makeRes();
    const next = jest.fn();
    adminAuth(req, res, next);
    // Header wins; wrong header → 401
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
