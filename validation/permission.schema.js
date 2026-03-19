// validation/permission.schema.js
const { z } = require("zod");

const bool = z.coerce.boolean().optional();
const nonNegInt = z.coerce.number().int().min(0).optional();

const base = z.object({
  maxCompanies: z.number().int().min(0).optional(),
  maxUsers: z.number().int().min(0).optional(),
  maxInventories: z.number().int().min(0).optional(),
  canSendInvoiceEmail: z.boolean().optional(),
  canSendInvoiceWhatsapp: z.boolean().optional(),
  canCreateUsers: z.boolean().optional(),
  canCreateCustomers: z.boolean().optional(),
  canCreateVendors: z.boolean().optional(),
  canCreateProducts: z.boolean().optional(),
  canCreateInventory: z.boolean().optional(),
  // ⬇️ add these
  canCreateCompanies: z.boolean().optional(),
  canUpdateCompanies: z.boolean().optional(),
  planCode: z.string().optional(),
}).strict(); // or .passthrough() if you want to allow unknowns

exports.putPermissionsSchema = base;
exports.patchPermissionsSchema = base.partial();
