/**
 * e2e/tests/admin/users-roles.api.spec.ts
 *
 * API tests for user and role administration.
 *
 * Routes (from src/app/api/users/ and src/app/api/roles/):
 *   GET    /api/users           users.view
 *   POST   /api/users           users.create
 *   GET    /api/users/:id       users.view
 *   PUT    /api/users/:id       users.update
 *   DELETE /api/users/:id       users.delete
 *
 *   GET    /api/roles           roles.view
 *   POST   /api/roles           roles.create
 *   GET    /api/roles/:id       roles.view
 *   PUT    /api/roles/:id       roles.update
 *   DELETE /api/roles/:id       roles.delete
 *
 * Validation schemas (from zip2):
 *   createUserSchema: { name: string, email: email, role?: string }
 *   createRoleSchema: { roleCode, roleName, description?, isActive?, permissionIds? }
 *   roleIdSchema / userIdSchema: positive integer string
 *
 * Business rules from service tests (zip2):
 *   - Duplicate email → 409 CONFLICT
 *   - Duplicate roleCode → 409 CONFLICT
 *   - Unknown role code on createUser → 422 VALIDATION_ERROR
 *   - Role self-update (same code) is allowed, no conflict
 *   - Update role: changing code to one owned by different role → 409
 */

import { test, expect } from "@fixtures/roles.fixture";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uniqueEmail() {
  return `playwright-test-${Date.now()}@test.local`;
}

function uniqueRoleCode() {
  return `TEST_ROLE_${Date.now()}`;
}

// ─── GET /api/users ───────────────────────────────────────────────────────────

test.describe("GET /api/users", () => {
  test("security-admin gets list with expected user shape", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/users");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    if (body.data.length > 0) {
      const u = body.data[0];
      // Fields from mapToUser() in user.repository.ts
      expect(u).toHaveProperty("id");
      expect(u).toHaveProperty("email");
      expect(u).toHaveProperty("name");
      expect(u).toHaveProperty("isActive");
      expect(u).toHaveProperty("role");
    }
  });

  test("accountant cannot GET users → 403", async ({ accountantApi }) => {
    expect((await accountantApi.get("/api/users")).status()).toBe(403);
  });

  test("ar-assistant cannot GET users → 403", async ({ arApi }) => {
    expect((await arApi.get("/api/users")).status()).toBe(403);
  });
});

// ─── POST /api/users ──────────────────────────────────────────────────────────

test.describe("POST /api/users — success paths", () => {
  test("creates user with valid payload, returns 201", async ({ securityAdminApi }) => {
    const email = uniqueEmail();
    const res = await securityAdminApi.post("/api/users", {
      data: { name: "Playwright Test User", email },
    });
    expect(res.status()).toBe(201);
    const user = (await res.json()).data;
    expect(user.email).toBe(email);
    expect(user.isActive).toBe(true);
    expect(user).toHaveProperty("id");
  });

  test("creates user with explicit role assignment", async ({ securityAdminApi }) => {
    const email = uniqueEmail();
    // Get a real role code from the DB first
    const rolesRes = await securityAdminApi.get("/api/roles");
    const roles = (await rolesRes.json()).data as Array<{ roleCode: string }>;
    if (roles.length === 0) return; // skip if no roles seeded

    const roleCode = roles[0].roleCode;
    const res = await securityAdminApi.post("/api/users", {
      data: { name: "Playwright Role User", email, role: roleCode },
    });
    expect(res.status()).toBe(201);
    const user = (await res.json()).data;
    expect(user.role).toBe(roleCode);
  });
});

test.describe("POST /api/users — validation", () => {
  test("duplicate email → 409 CONFLICT", async ({ securityAdminApi }) => {
    const email = uniqueEmail();
    await securityAdminApi.post("/api/users", {
      data: { name: "First", email },
    });
    const res = await securityAdminApi.post("/api/users", {
      data: { name: "Second", email },   // same email
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  test("invalid email format → 422", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/users", {
      data: { name: "Bad Email", email: "not-an-email" },
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  test("missing name → 422", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/users", {
      data: { email: uniqueEmail() },
    });
    expect(res.status()).toBe(422);
  });

  test("unknown role code → 422 VALIDATION_ERROR", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/users", {
      data: { name: "X", email: uniqueEmail(), role: "NONEXISTENT_ROLE_CODE_XYZ" },
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

// ─── GET/PUT/DELETE /api/users/:id ────────────────────────────────────────────

test.describe("GET /api/users/:id", () => {
  test("returns user by id", async ({ securityAdminApi }) => {
    // Create then immediately fetch
    const email = uniqueEmail();
    const created = await (await securityAdminApi.post("/api/users", {
      data: { name: "Fetch Test", email },
    })).json();
    const userId = created.data.id;

    const res = await securityAdminApi.get(`/api/users/${userId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).data.id).toBe(userId);
  });

  test("unknown id → 404", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.get("/api/users/99999999")).status()).toBe(404);
  });

  test("non-numeric id → 422", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.get("/api/users/abc")).status()).toBe(422);
  });
});

test.describe("PUT /api/users/:id", () => {
  test("updates user name successfully", async ({ securityAdminApi }) => {
    const email = uniqueEmail();
    const created = await (await securityAdminApi.post("/api/users", {
      data: { name: "Before Update", email },
    })).json();
    const userId = created.data.id;

    const res = await securityAdminApi.put(`/api/users/${userId}`, {
      data: { name: "After Update", email },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.name).toBe("After Update");
  });

  test("unknown id → 404", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.put("/api/users/99999999", {
      data: { name: "X" },
    })).status()).toBe(404);
  });
});

test.describe("DELETE /api/users/:id", () => {
  test("deletes user and returns { deleted: true }", async ({ securityAdminApi }) => {
    const email = uniqueEmail();
    const created = await (await securityAdminApi.post("/api/users", {
      data: { name: "To Delete", email },
    })).json();
    const userId = created.data.id;

    const res = await securityAdminApi.delete(`/api/users/${userId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).data.deleted).toBe(true);
  });

  test("deleted user cannot be fetched → 404", async ({ securityAdminApi }) => {
    const email = uniqueEmail();
    const created = await (await securityAdminApi.post("/api/users", {
      data: { name: "Cascade Delete", email },
    })).json();
    const userId = created.data.id;

    await securityAdminApi.delete(`/api/users/${userId}`);
    expect((await securityAdminApi.get(`/api/users/${userId}`)).status()).toBe(404);
  });

  test("accountant cannot delete users → 403", async ({ accountantApi }) => {
    expect((await accountantApi.delete("/api/users/1")).status()).toBe(403);
  });
});

// ─── GET /api/roles ───────────────────────────────────────────────────────────

test.describe("GET /api/roles", () => {
  test("security-admin gets list with role shape", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.get("/api/roles");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    if (body.data.length > 0) {
      const r = body.data[0];
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("roleCode");
      expect(r).toHaveProperty("roleName");
      expect(r).toHaveProperty("isActive");
    }
  });

  test("accountant cannot GET roles → 403", async ({ accountantApi }) => {
    expect((await accountantApi.get("/api/roles")).status()).toBe(403);
  });
});

// ─── POST /api/roles ──────────────────────────────────────────────────────────

test.describe("POST /api/roles — success paths", () => {
  test("creates role, returns 201 with permissions array", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/roles", {
      data: {
        roleCode:    uniqueRoleCode(),
        roleName:    "Playwright Test Role",
        description: "Created by E2E test",
        isActive:    true,
        permissionIds: [],
      },
    });
    expect(res.status()).toBe(201);
    const role = (await res.json()).data;
    expect(role).toHaveProperty("id");
    expect(Array.isArray(role.permissions)).toBe(true);
  });
});

test.describe("POST /api/roles — validation", () => {
  test("duplicate roleCode → 409 CONFLICT", async ({ securityAdminApi }) => {
    const code = uniqueRoleCode();
    await securityAdminApi.post("/api/roles", {
      data: { roleCode: code, roleName: "First", permissionIds: [] },
    });
    const res = await securityAdminApi.post("/api/roles", {
      data: { roleCode: code, roleName: "Second", permissionIds: [] },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  test("empty roleCode → 422", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/roles", {
      data: { roleCode: "", roleName: "Test", permissionIds: [] },
    });
    expect(res.status()).toBe(422);
  });

  test("missing roleName → 422", async ({ securityAdminApi }) => {
    const res = await securityAdminApi.post("/api/roles", {
      data: { roleCode: uniqueRoleCode() },
    });
    expect(res.status()).toBe(422);
  });
});

// ─── GET/PUT/DELETE /api/roles/:id ────────────────────────────────────────────

test.describe("GET /api/roles/:id", () => {
  test("returns role with permissions array", async ({ securityAdminApi }) => {
    const code = uniqueRoleCode();
    const created = await (await securityAdminApi.post("/api/roles", {
      data: { roleCode: code, roleName: "Fetch Test", permissionIds: [] },
    })).json();

    const res = await securityAdminApi.get(`/api/roles/${created.data.id}`);
    expect(res.status()).toBe(200);
    const role = (await res.json()).data;
    expect(role.roleCode).toBe(code);
    expect(Array.isArray(role.permissions)).toBe(true);
  });

  test("non-numeric id → 422 (roleIdSchema)", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.get("/api/roles/abc")).status()).toBe(422);
  });

  test("unknown id → 404", async ({ securityAdminApi }) => {
    expect((await securityAdminApi.get("/api/roles/99999999")).status()).toBe(404);
  });
});

test.describe("PUT /api/roles/:id", () => {
  test("updates roleName successfully", async ({ securityAdminApi }) => {
    const code = uniqueRoleCode();
    const created = await (await securityAdminApi.post("/api/roles", {
      data: { roleCode: code, roleName: "Before", permissionIds: [] },
    })).json();
    const roleId = created.data.id;

    const res = await securityAdminApi.put(`/api/roles/${roleId}`, {
      data: { roleName: "After Update" },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).data.roleName).toBe("After Update");
  });

  test("updating roleCode to same value (self-update) → 200, no conflict", async ({ securityAdminApi }) => {
    const code = uniqueRoleCode();
    const created = await (await securityAdminApi.post("/api/roles", {
      data: { roleCode: code, roleName: "Self Update", permissionIds: [] },
    })).json();
    const roleId = created.data.id;

    const res = await securityAdminApi.put(`/api/roles/${roleId}`, {
      data: { roleCode: code },
    });
    expect(res.status()).toBe(200);
  });

  test("updating roleCode to another role's code → 409", async ({ securityAdminApi }) => {
    const codeA = uniqueRoleCode();
    const codeB = uniqueRoleCode() + "B";

    const roleA = await (await securityAdminApi.post("/api/roles", {
      data: { roleCode: codeA, roleName: "Role A", permissionIds: [] },
    })).json();
    await securityAdminApi.post("/api/roles", {
      data: { roleCode: codeB, roleName: "Role B", permissionIds: [] },
    });

    const res = await securityAdminApi.put(`/api/roles/${roleA.data.id}`, {
      data: { roleCode: codeB },    // codeB belongs to a different role
    });
    expect(res.status()).toBe(409);
  });
});

test.describe("DELETE /api/roles/:id", () => {
  test("deletes role and verifies it is gone", async ({ securityAdminApi }) => {
    const created = await (await securityAdminApi.post("/api/roles", {
      data: { roleCode: uniqueRoleCode(), roleName: "To Delete", permissionIds: [] },
    })).json();
    const roleId = created.data.id;

    const del = await securityAdminApi.delete(`/api/roles/${roleId}`);
    expect(del.status()).toBe(200);
    expect((await del.json()).data.deleted).toBe(true);

    expect((await securityAdminApi.get(`/api/roles/${roleId}`)).status()).toBe(404);
  });

  test("accountant cannot delete roles → 403", async ({ accountantApi }) => {
    expect((await accountantApi.delete("/api/roles/1")).status()).toBe(403);
  });
});
