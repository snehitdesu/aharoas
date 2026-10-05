/**
 * Aharos — demo restaurant seed.
 *
 * Safely resettable for development: deletes existing rows (dependency-safe
 * order) then rebuilds a realistic restaurant group. Sample data flows through
 * the REAL domain services so the ledger, costing, KOTs, payments, recipe
 * explosion and POS idempotency are all genuinely exercised — not faked.
 *
 * Verified chains:
 *   vendor -> PO -> GRN -> inventory ledger
 *   recipe -> menu item -> order -> payment -> explosion -> consumption
 *   mock POS webhook -> idempotency -> normalized order -> consumption
 *
 * Run: npm run db:seed   (or npm run setup)
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { hashPassword } from "@/server/auth/password";
import {
  recordPurchaseReceipt,
  recordWastage,
  recordProductionConsumption,
  recordProductionOutput,
  recordCountAdjustment,
  currentQuantity,
} from "@/server/services/inventory";
import { createOrder, addOrderItem, submitOrder } from "@/server/services/orders";
import { createKOTsForOrder } from "@/server/services/kot";
import { createPayment, verifyPayment } from "@/server/services/payment";
import { receivePOSWebhook } from "@/server/services/pos";
import { MockPOSProvider } from "@/integrations/pos";
import type { AccessContext } from "@/server/db/scope";

const DEMO_PASSWORD = "Demo@12345";

async function deleteAll() {
  // children -> parents (respects Restrict FKs)
  const ops = [
    prisma.refund, prisma.payment,
    prisma.kotItem, prisma.kot,
    prisma.orderItemModifier, prisma.orderItem, prisma.order,
    prisma.loyaltyTransaction, prisma.loyaltyAccount, prisma.customerAddress, prisma.feedback, prisma.reservation, prisma.waitlistEntry, prisma.customer,
    prisma.inventoryLedger, prisma.outletMaterialCost,
    prisma.purchaseBillLine, prisma.vendorPayment, prisma.purchaseBill,
    prisma.goodsReceiptLine, prisma.goodsReceipt,
    prisma.purchaseOrderLine, prisma.purchaseOrder,
    prisma.purchaseIndentLine, prisma.purchaseIndent,
    prisma.inventoryTransferLine, prisma.inventoryTransfer,
    prisma.inventoryIssueLine, prisma.inventoryIssue,
    prisma.wastageLine, prisma.wastage,
    prisma.stockCountLine, prisma.stockCount,
    prisma.productionLine, prisma.productionBatch,
    prisma.recipeLine, prisma.recipeVersion, prisma.recipe,
    prisma.menuItemModifierGroup, prisma.modifierOption, prisma.modifierGroup, prisma.menuItemVariant, prisma.menuItem, prisma.menuCategory,
    prisma.vendorMaterial, prisma.vendor,
    prisma.outletMaterialCost, prisma.material, prisma.materialCategory, prisma.unitConversion, prisma.unit,
    prisma.restaurantTable, prisma.floor, prisma.kitchenStation, prisma.department,
    prisma.attendance, prisma.shift, prisma.leaveRequest, prisma.task,
    prisma.expense, prisma.pettyCashTxn, prisma.cashDrawerSession, prisma.reconciliationLine, prisma.reconciliation,
    prisma.aggregatorOrder, prisma.aggregatorSettlement, prisma.aggregator,
    prisma.anomaly, prisma.notification, prisma.auditLog, prisma.webhookEvent, prisma.unmappedSale, prisma.integrationConnection, prisma.syncJob, prisma.exportJob,
    prisma.session, prisma.membership, prisma.user, prisma.outlet, prisma.organization,
  ];
  for (const model of ops) {
    // @ts-expect-error uniform deleteMany across delegates
    await model.deleteMany({});
  }
}

/**
 * The seed WIPES every table and creates accounts with a public password. Refuse
 * to run where that would be a disaster: in production mode, or against a
 * database holding any non-demo user (e.g. production with NODE_ENV unset).
 * ALLOW_DEMO_SEED=true overrides both (disposable test databases only).
 */
async function assertSafeToSeed() {
  if (process.env.ALLOW_DEMO_SEED === "true") return;
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed: NODE_ENV=production. The demo seed deletes all data and creates accounts with a public password. Set ALLOW_DEMO_SEED=true only for a disposable database.");
  }
  const real = await prisma.user.count({ where: { NOT: { email: { endsWith: "@demo.local" } } } });
  if (real > 0) {
    throw new Error(`Refusing to seed: the database has ${real} non-demo user(s) — it looks like real data. Set ALLOW_DEMO_SEED=true only if this database is disposable.`);
  }
}

async function main() {
  await assertSafeToSeed();
  console.log("Resetting demo data...");
  await deleteAll();

  // ---------------- A. Organization + outlets ----------------
  const org = await prisma.organization.create({
    data: { name: "Aharos Demo Restaurant Group", legalName: "Aharos Foods Pvt Ltd", gstin: "36ABCDE1234F1Z1", currency: "INR", timezone: "Asia/Kolkata" },
  });
  const orgId = org.id;

  const outletCentral = await prisma.outlet.create({
    data: { organizationId: orgId, code: "HYDCEN", name: "Hyderabad Central", address: "Road No 1, Banjara Hills, Hyderabad", gstin: "36ABCDE1234F1Z1", phone: "+914012345678", openTime: "11:00", closeTime: "23:30" },
  });
  const outletJubilee = await prisma.outlet.create({
    data: { organizationId: orgId, code: "HYDJUB", name: "Hyderabad Jubilee Hills", address: "Road No 36, Jubilee Hills, Hyderabad", gstin: "36ABCDE1234F2Z0", phone: "+914012345679", openTime: "11:00", closeTime: "23:30" },
  });
  const outlets = [outletCentral, outletJubilee];
  const ctx: AccessContext = systemContext(orgId, outlets.map((o) => o.id));

  // ---------------- B. Departments + kitchen stations ----------------
  const deptKinds: Array<{ name: string; kind: string }> = [
    { name: "Store", kind: "STORE" },
    { name: "Kitchen", kind: "KITCHEN" },
    { name: "Bar", kind: "BAR" },
    { name: "Bakery", kind: "BAKERY" },
  ];
  const deptByOutlet: Record<string, Record<string, string>> = {};
  for (const o of outlets) {
    deptByOutlet[o.id] = {};
    for (const d of deptKinds) {
      const dep = await prisma.department.create({ data: { organizationId: orgId, outletId: o.id, name: d.name, kind: d.kind } });
      deptByOutlet[o.id][d.kind] = dep.id;
    }
    // Stations named to match MenuItem.station values (KITCHEN | BAR | BAKERY).
    for (const s of ["KITCHEN", "BAR", "BAKERY"]) {
      await prisma.kitchenStation.create({ data: { organizationId: orgId, outletId: o.id, name: s, kind: s } });
    }
  }

  // ---------------- C. Users / memberships / roles ----------------
  const pwd = await hashPassword(DEMO_PASSWORD);
  async function makeUser(email: string, name: string, role: string, outletId: string | null, isSuperAdmin = false) {
    const user = await prisma.user.create({ data: { organizationId: orgId, email, name, passwordHash: pwd, isSuperAdmin } });
    await prisma.membership.create({ data: { organizationId: orgId, userId: user.id, outletId, role } });
    return user;
  }
  await makeUser("owner@demo.local", "Priya Owner", "OWNER", null);
  await makeUser("admin@demo.local", "Arjun Admin", "ADMIN", null);
  await makeUser("area@demo.local", "Asha Area", "AREA_MANAGER", null);
  await makeUser("manager@demo.local", "Manoj Manager", "MANAGER", outletCentral.id);
  await makeUser("store@demo.local", "Sita Store", "STORE", outletCentral.id);
  await makeUser("kitchen@demo.local", "Kiran Kitchen", "KITCHEN", outletCentral.id);
  await makeUser("captain@demo.local", "Chetan Captain", "CAPTAIN", outletCentral.id);
  await makeUser("cashier@demo.local", "Chandni Cashier", "CASHIER", outletCentral.id);
  await makeUser("manager2@demo.local", "Meera Manager", "MANAGER", outletJubilee.id);

  // ---------------- D. Units + materials ----------------
  const unitDefs = [
    { code: "kg", name: "Kilogram", kind: "WEIGHT" },
    { code: "g", name: "Gram", kind: "WEIGHT" },
    { code: "L", name: "Litre", kind: "VOLUME" },
    { code: "ml", name: "Millilitre", kind: "VOLUME" },
    { code: "pc", name: "Piece", kind: "COUNT" },
  ];
  const unitByCode: Record<string, string> = {};
  for (const u of unitDefs) {
    const unit = await prisma.unit.create({ data: { organizationId: orgId, code: u.code, name: u.name, kind: u.kind } });
    unitByCode[u.code] = unit.id;
  }
  // Global conversions
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: unitByCode.kg, toUnitId: unitByCode.g, factor: 1000 } });
  await prisma.unitConversion.create({ data: { organizationId: orgId, fromUnitId: unitByCode.L, toUnitId: unitByCode.ml, factor: 1000 } });

  const categoryNames = ["Grains", "Meat & Poultry", "Dairy", "Vegetables", "Spices", "Oils & Fats", "Beverages", "Bakery", "Semi-Finished"];
  const catByName: Record<string, string> = {};
  for (const c of categoryNames) {
    const cat = await prisma.materialCategory.create({ data: { organizationId: orgId, name: c } });
    catByName[c] = cat.id;
  }

  type MatDef = { sku: string; name: string; cat: string; unit: string; rate: number; reorder: number; tax: number; perishable?: boolean; semi?: boolean };
  const materialDefs: MatDef[] = [
    { sku: "GR-RICE", name: "Basmati Rice", cat: "Grains", unit: "kg", rate: 90, reorder: 20, tax: 5 },
    { sku: "GR-WHEAT", name: "Wheat Flour", cat: "Grains", unit: "kg", rate: 40, reorder: 15, tax: 5 },
    { sku: "GR-TOORDAL", name: "Toor Dal", cat: "Grains", unit: "kg", rate: 110, reorder: 8, tax: 5 },
    { sku: "MT-CHICKEN", name: "Chicken", cat: "Meat & Poultry", unit: "kg", rate: 220, reorder: 10, tax: 5, perishable: true },
    { sku: "MT-MUTTON", name: "Mutton", cat: "Meat & Poultry", unit: "kg", rate: 650, reorder: 5, tax: 5, perishable: true },
    { sku: "MT-FISH", name: "Fish", cat: "Meat & Poultry", unit: "kg", rate: 300, reorder: 5, tax: 5, perishable: true },
    { sku: "DA-PANEER", name: "Paneer", cat: "Dairy", unit: "kg", rate: 320, reorder: 8, tax: 5, perishable: true },
    { sku: "DA-MILK", name: "Milk", cat: "Dairy", unit: "L", rate: 60, reorder: 20, tax: 0, perishable: true },
    { sku: "DA-BUTTER", name: "Butter", cat: "Dairy", unit: "kg", rate: 480, reorder: 5, tax: 12 },
    { sku: "DA-CREAM", name: "Cream", cat: "Dairy", unit: "L", rate: 180, reorder: 5, tax: 12, perishable: true },
    { sku: "DA-YOGURT", name: "Yogurt", cat: "Dairy", unit: "kg", rate: 80, reorder: 8, tax: 5, perishable: true },
    { sku: "DA-CHEESE", name: "Cheese", cat: "Dairy", unit: "kg", rate: 420, reorder: 3, tax: 12 },
    { sku: "VG-ONION", name: "Onion", cat: "Vegetables", unit: "kg", rate: 35, reorder: 25, tax: 0, perishable: true },
    { sku: "VG-TOMATO", name: "Tomato", cat: "Vegetables", unit: "kg", rate: 40, reorder: 25, tax: 0, perishable: true },
    { sku: "VG-POTATO", name: "Potato", cat: "Vegetables", unit: "kg", rate: 30, reorder: 20, tax: 0, perishable: true },
    { sku: "VG-GINGER", name: "Ginger", cat: "Vegetables", unit: "kg", rate: 120, reorder: 5, tax: 0, perishable: true },
    { sku: "VG-GARLIC", name: "Garlic", cat: "Vegetables", unit: "kg", rate: 140, reorder: 5, tax: 0, perishable: true },
    { sku: "VG-CHILLI", name: "Green Chilli", cat: "Vegetables", unit: "kg", rate: 60, reorder: 4, tax: 0, perishable: true },
    { sku: "VG-CAPSICUM", name: "Capsicum", cat: "Vegetables", unit: "kg", rate: 70, reorder: 5, tax: 0, perishable: true },
    { sku: "VG-CORIANDER", name: "Coriander Leaves", cat: "Vegetables", unit: "kg", rate: 40, reorder: 3, tax: 0, perishable: true },
    { sku: "SP-CUMIN", name: "Cumin", cat: "Spices", unit: "kg", rate: 380, reorder: 3, tax: 5 },
    { sku: "SP-CORIANDERSEED", name: "Coriander Seeds", cat: "Spices", unit: "kg", rate: 220, reorder: 3, tax: 5 },
    { sku: "SP-CHILLIPOW", name: "Red Chilli Powder", cat: "Spices", unit: "kg", rate: 300, reorder: 3, tax: 5 },
    { sku: "SP-TURMERIC", name: "Turmeric", cat: "Spices", unit: "kg", rate: 260, reorder: 2, tax: 5 },
    { sku: "SP-GARAM", name: "Garam Masala", cat: "Spices", unit: "kg", rate: 600, reorder: 2, tax: 5 },
    { sku: "SP-SALT", name: "Salt", cat: "Spices", unit: "kg", rate: 20, reorder: 10, tax: 5 },
    { sku: "OL-OIL", name: "Refined Oil", cat: "Oils & Fats", unit: "L", rate: 140, reorder: 15, tax: 5 },
    { sku: "OL-GHEE", name: "Ghee", cat: "Oils & Fats", unit: "kg", rate: 620, reorder: 4, tax: 12 },
    { sku: "BV-COFFEE", name: "Coffee Powder", cat: "Beverages", unit: "kg", rate: 500, reorder: 2, tax: 18 },
    { sku: "BV-TEA", name: "Tea Powder", cat: "Beverages", unit: "kg", rate: 350, reorder: 2, tax: 5 },
    { sku: "BV-WATER", name: "Mineral Water", cat: "Beverages", unit: "pc", rate: 10, reorder: 50, tax: 18 },
    { sku: "BK-SUGAR", name: "Sugar", cat: "Bakery", unit: "kg", rate: 45, reorder: 15, tax: 5 },
    { sku: "BK-CASHEW", name: "Cashew", cat: "Bakery", unit: "kg", rate: 800, reorder: 3, tax: 5 },
    { sku: "BK-EGGS", name: "Eggs", cat: "Bakery", unit: "pc", rate: 6, reorder: 100, tax: 0, perishable: true },
    // Semi-finished (produced in-house)
    { sku: "SF-GGP", name: "Ginger Garlic Paste", cat: "Semi-Finished", unit: "kg", rate: 0, reorder: 2, tax: 0, semi: true },
    { sku: "SF-BMASALA", name: "Biryani Masala Prep", cat: "Semi-Finished", unit: "kg", rate: 0, reorder: 1, tax: 0, semi: true },
    { sku: "SF-BCGRAVY", name: "Butter Chicken Gravy Prep", cat: "Semi-Finished", unit: "kg", rate: 0, reorder: 2, tax: 0, semi: true },
  ];
  const matByName: Record<string, { id: string; unit: string }> = {};
  for (const m of materialDefs) {
    const mat = await prisma.material.create({
      data: {
        organizationId: orgId, sku: m.sku, name: m.name, categoryId: catByName[m.cat],
        baseUnitId: unitByCode[m.unit], taxPct: m.tax, reorderLevel: m.reorder, minStock: m.reorder,
        perishable: m.perishable ?? false,
      },
    });
    matByName[m.name] = { id: mat.id, unit: m.unit };
  }
  const rateByName: Record<string, number> = Object.fromEntries(materialDefs.map((m) => [m.name, m.rate]));

  // ---------------- E. Vendors + vendor-material links ----------------
  const vendorDefs = [
    { name: "Sri Balaji Provisions", cat: "Grains", terms: "NET15" },
    { name: "Deccan Poultry Farm", cat: "Meat & Poultry", terms: "COD" },
    { name: "Vijaya Dairy Supplies", cat: "Dairy", terms: "NET7" },
    { name: "Rythu Bazar Vegetables", cat: "Vegetables", terms: "COD" },
    { name: "MTR Spice House", cat: "Spices", terms: "NET30" },
    { name: "Gold Drop Oils", cat: "Oils & Fats", terms: "NET15" },
    { name: "Blue Tokai Beverages", cat: "Beverages", terms: "NET30" },
    { name: "Karachi Bakery Supplies", cat: "Bakery", terms: "NET15" },
    { name: "Metro Cash & Carry", cat: "Grains", terms: "NET7" },
    { name: "Reliance Wholesale", cat: "Dairy", terms: "NET15" },
  ];
  const vendors: Array<{ id: string; cat: string }> = [];
  for (const v of vendorDefs) {
    const vendor = await prisma.vendor.create({
      data: { organizationId: orgId, name: v.name, companyName: v.name, phone: "+9198" + Math.floor(10000000 + Math.random() * 89999999), gstin: "36VEND" + Math.floor(1000 + Math.random() * 8999) + "Z", paymentTerms: v.terms, creditLimit: 100000 },
    });
    vendors.push({ id: vendor.id, cat: v.cat });
    // link materials of matching category
    for (const m of materialDefs.filter((mm) => mm.cat === v.cat && !mm.semi)) {
      await prisma.vendorMaterial.create({ data: { organizationId: orgId, vendorId: vendor.id, materialId: matByName[m.name].id, lastRate: m.rate, preferred: true } });
    }
  }
  const vendorForCat = (cat: string) => vendors.find((v) => v.cat === cat)?.id ?? vendors[0].id;

  // ---------------- G. Menu categories + menu items ----------------
  const menuCatNames = ["Biryani", "Main Course", "Starters", "Breads", "Rice", "Beverages", "Desserts"];
  const menuCatByName: Record<string, string> = {};
  let sort = 0;
  for (const c of menuCatNames) {
    const mc = await prisma.menuCategory.create({ data: { organizationId: orgId, name: c, sortOrder: sort++ } });
    menuCatByName[c] = mc.id;
  }
  type MenuDef = { code: string; name: string; cat: string; price: number; station: string; veg: boolean };
  const menuDefs: MenuDef[] = [
    { code: "M001", name: "Chicken Biryani", cat: "Biryani", price: 320, station: "KITCHEN", veg: false },
    { code: "M002", name: "Mutton Biryani", cat: "Biryani", price: 420, station: "KITCHEN", veg: false },
    { code: "M003", name: "Veg Biryani", cat: "Biryani", price: 240, station: "KITCHEN", veg: true },
    { code: "M010", name: "Butter Chicken", cat: "Main Course", price: 340, station: "KITCHEN", veg: false },
    { code: "M011", name: "Paneer Butter Masala", cat: "Main Course", price: 300, station: "KITCHEN", veg: true },
    { code: "M012", name: "Dal Tadka", cat: "Main Course", price: 200, station: "KITCHEN", veg: true },
    { code: "M013", name: "Chicken Curry", cat: "Main Course", price: 320, station: "KITCHEN", veg: false },
    { code: "M014", name: "Fish Curry", cat: "Main Course", price: 360, station: "KITCHEN", veg: false },
    { code: "M020", name: "Paneer Tikka", cat: "Starters", price: 280, station: "KITCHEN", veg: true },
    { code: "M021", name: "Chicken Tikka", cat: "Starters", price: 320, station: "KITCHEN", veg: false },
    { code: "M030", name: "Butter Naan", cat: "Breads", price: 60, station: "BAKERY", veg: true },
    { code: "M031", name: "Tandoori Roti", cat: "Breads", price: 40, station: "BAKERY", veg: true },
    { code: "M032", name: "Garlic Naan", cat: "Breads", price: 70, station: "BAKERY", veg: true },
    { code: "M040", name: "Jeera Rice", cat: "Rice", price: 180, station: "KITCHEN", veg: true },
    { code: "M041", name: "Steamed Rice", cat: "Rice", price: 120, station: "KITCHEN", veg: true },
    { code: "M050", name: "Cold Coffee", cat: "Beverages", price: 160, station: "BAR", veg: true },
    { code: "M051", name: "Masala Chai", cat: "Beverages", price: 40, station: "BAR", veg: true },
    { code: "M052", name: "Fresh Lime Soda", cat: "Beverages", price: 80, station: "BAR", veg: true },
    { code: "M053", name: "Cola", cat: "Beverages", price: 60, station: "BAR", veg: true },
    { code: "M054", name: "Mineral Water", cat: "Beverages", price: 20, station: "BAR", veg: true },
    { code: "M060", name: "Gulab Jamun", cat: "Desserts", price: 120, station: "BAKERY", veg: true },
    { code: "M061", name: "Ice Cream", cat: "Desserts", price: 100, station: "BAR", veg: true },
  ];
  const menuByCode: Record<string, string> = {};
  const menuByName: Record<string, string> = {};
  for (const mi of menuDefs) {
    const item = await prisma.menuItem.create({
      data: { organizationId: orgId, categoryId: menuCatByName[mi.cat], name: mi.name, price: mi.price, taxPct: 5, station: mi.station, posCode: mi.code, isVeg: mi.veg },
    });
    menuByCode[mi.code] = item.id;
    menuByName[mi.name] = item.id;
  }
  // A couple of modifiers
  const spiceGroup = await prisma.modifierGroup.create({ data: { organizationId: orgId, name: "Spice Level", minSelect: 0, maxSelect: 1 } });
  for (const opt of ["Mild", "Medium", "Spicy"]) await prisma.modifierOption.create({ data: { organizationId: orgId, groupId: spiceGroup.id, name: opt } });
  await prisma.menuItemModifierGroup.create({ data: { menuItemId: menuByCode.M001, groupId: spiceGroup.id } });

  // ---------------- F. Recipes + versions + nested sub-recipes ----------------
  type Line = { m?: string; sub?: string; qty: number; wastage?: number };
  const recipeIdByName: Record<string, string> = {};
  async function createRecipe(name: string, outputType: "MENU_ITEM" | "SUB_RECIPE", opts: { menuItem?: string; outputMaterial?: string; yieldQty: number; yieldUnit: string; lines: Line[] }) {
    const recipe = await prisma.recipe.create({
      data: {
        organizationId: orgId, name, outputType,
        menuItemId: opts.menuItem ? menuByName[opts.menuItem] : undefined,
        outputMaterialId: opts.outputMaterial ? matByName[opts.outputMaterial].id : undefined,
      },
    });
    recipeIdByName[name] = recipe.id;
    const version = await prisma.recipeVersion.create({
      data: { organizationId: orgId, recipeId: recipe.id, version: 1, status: "APPROVED", yieldQty: opts.yieldQty, yieldUnitId: unitByCode[opts.yieldUnit], approvedAt: new Date() },
    });
    let sortOrder = 0;
    for (const l of opts.lines) {
      if (l.m) {
        await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: version.id, componentType: "MATERIAL", materialId: matByName[l.m].id, qty: l.qty, wastagePct: l.wastage ?? 0, sortOrder: sortOrder++ } });
      } else if (l.sub) {
        await prisma.recipeLine.create({ data: { organizationId: orgId, recipeVersionId: version.id, componentType: "SUB_RECIPE", subRecipeId: recipeIdByName[l.sub], qty: l.qty, wastagePct: l.wastage ?? 0, sortOrder: sortOrder++ } });
      }
    }
    return recipe.id;
  }

  // Sub-recipes first (gravy nests the ginger-garlic paste => 3-level nesting)
  await createRecipe("Ginger Garlic Paste", "SUB_RECIPE", { outputMaterial: "Ginger Garlic Paste", yieldQty: 1, yieldUnit: "kg", lines: [{ m: "Ginger", qty: 0.5 }, { m: "Garlic", qty: 0.5 }] });
  await createRecipe("Biryani Masala Prep", "SUB_RECIPE", { outputMaterial: "Biryani Masala Prep", yieldQty: 1, yieldUnit: "kg", lines: [{ m: "Coriander Seeds", qty: 0.3 }, { m: "Cumin", qty: 0.2 }, { m: "Red Chilli Powder", qty: 0.15 }, { m: "Garam Masala", qty: 0.15 }, { m: "Turmeric", qty: 0.1 }, { m: "Salt", qty: 0.1 }] });
  await createRecipe("Butter Chicken Gravy Prep", "SUB_RECIPE", { outputMaterial: "Butter Chicken Gravy Prep", yieldQty: 5, yieldUnit: "kg", lines: [{ m: "Tomato", qty: 2.5 }, { m: "Butter", qty: 0.5 }, { m: "Cream", qty: 0.4 }, { m: "Cashew", qty: 0.3 }, { m: "Onion", qty: 0.5 }, { sub: "Ginger Garlic Paste", qty: 0.2 }, { m: "Red Chilli Powder", qty: 0.05 }, { m: "Salt", qty: 0.05 }] });

  // Main recipes (some reference sub-recipes)
  await createRecipe("Chicken Biryani", "MENU_ITEM", { menuItem: "Chicken Biryani", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Chicken", qty: 0.25 }, { m: "Basmati Rice", qty: 0.18 }, { m: "Refined Oil", qty: 0.03 }, { m: "Onion", qty: 0.08 }, { sub: "Biryani Masala Prep", qty: 0.04 }, { m: "Coriander Leaves", qty: 0.01, wastage: 5 }] });
  await createRecipe("Mutton Biryani", "MENU_ITEM", { menuItem: "Mutton Biryani", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Mutton", qty: 0.25 }, { m: "Basmati Rice", qty: 0.18 }, { m: "Refined Oil", qty: 0.03 }, { m: "Onion", qty: 0.08 }, { sub: "Biryani Masala Prep", qty: 0.04 }] });
  await createRecipe("Veg Biryani", "MENU_ITEM", { menuItem: "Veg Biryani", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Basmati Rice", qty: 0.18 }, { m: "Potato", qty: 0.06 }, { m: "Capsicum", qty: 0.05 }, { m: "Onion", qty: 0.08 }, { sub: "Biryani Masala Prep", qty: 0.04 }, { m: "Refined Oil", qty: 0.03 }] });
  await createRecipe("Butter Chicken", "MENU_ITEM", { menuItem: "Butter Chicken", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Chicken", qty: 0.25 }, { sub: "Butter Chicken Gravy Prep", qty: 0.3 }, { m: "Butter", qty: 0.02 }] });
  await createRecipe("Paneer Butter Masala", "MENU_ITEM", { menuItem: "Paneer Butter Masala", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Paneer", qty: 0.2 }, { sub: "Butter Chicken Gravy Prep", qty: 0.25 }, { m: "Cream", qty: 0.02 }] });
  await createRecipe("Dal Tadka", "MENU_ITEM", { menuItem: "Dal Tadka", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Toor Dal", qty: 0.1 }, { m: "Tomato", qty: 0.05 }, { m: "Onion", qty: 0.05 }, { m: "Ghee", qty: 0.02 }, { m: "Turmeric", qty: 0.005 }, { m: "Salt", qty: 0.005 }] });
  await createRecipe("Jeera Rice", "MENU_ITEM", { menuItem: "Jeera Rice", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Basmati Rice", qty: 0.15 }, { m: "Cumin", qty: 0.01 }, { m: "Ghee", qty: 0.02 }, { m: "Salt", qty: 0.005 }] });
  await createRecipe("Steamed Rice", "MENU_ITEM", { menuItem: "Steamed Rice", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Basmati Rice", qty: 0.15 }, { m: "Salt", qty: 0.003 }] });
  await createRecipe("Butter Naan", "MENU_ITEM", { menuItem: "Butter Naan", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Wheat Flour", qty: 0.12 }, { m: "Butter", qty: 0.02 }, { m: "Milk", qty: 0.03 }, { m: "Salt", qty: 0.003 }] });
  await createRecipe("Paneer Tikka", "MENU_ITEM", { menuItem: "Paneer Tikka", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Paneer", qty: 0.2 }, { m: "Yogurt", qty: 0.05 }, { m: "Red Chilli Powder", qty: 0.005 }, { m: "Capsicum", qty: 0.03 }, { m: "Onion", qty: 0.03 }, { m: "Salt", qty: 0.003 }] });
  await createRecipe("Cold Coffee", "MENU_ITEM", { menuItem: "Cold Coffee", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Milk", qty: 0.2 }, { m: "Coffee Powder", qty: 0.01 }, { m: "Sugar", qty: 0.02 }] });
  await createRecipe("Masala Chai", "MENU_ITEM", { menuItem: "Masala Chai", yieldQty: 1, yieldUnit: "pc", lines: [{ m: "Milk", qty: 0.1 }, { m: "Tea Powder", qty: 0.005 }, { m: "Sugar", qty: 0.015 }] });

  // ---------------- H. Floors + tables ----------------
  const tableCount: Record<string, number> = {};
  for (const o of outlets) {
    const ground = await prisma.floor.create({ data: { organizationId: orgId, outletId: o.id, name: "Ground Floor", sortOrder: 0 } });
    const first = await prisma.floor.create({ data: { organizationId: orgId, outletId: o.id, name: "First Floor", sortOrder: 1 } });
    let n = 0;
    for (let i = 1; i <= 8; i++) { await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: o.id, floorId: ground.id, code: `G${i}`, capacity: i % 3 === 0 ? 6 : 4, qrToken: randomBytes(18).toString("base64url") } }); n++; }
    const firstCount = o.id === outletCentral.id ? 6 : 4;
    for (let i = 1; i <= firstCount; i++) { await prisma.restaurantTable.create({ data: { organizationId: orgId, outletId: o.id, floorId: first.id, code: `F${i}`, capacity: 4, qrToken: randomBytes(18).toString("base64url") } }); n++; }
    tableCount[o.id] = n;
  }

  // ---------------- I. Customers + loyalty ----------------
  const firstNames = ["Rahul", "Sneha", "Vikram", "Ananya", "Rohit", "Divya", "Karthik", "Pooja", "Aditya", "Meghana", "Suresh", "Lakshmi", "Naveen", "Swathi", "Ramesh", "Kavya", "Aravind", "Nisha", "Sandeep", "Harika"];
  const customers: string[] = [];
  for (let i = 0; i < firstNames.length; i++) {
    const c = await prisma.customer.create({
      data: { organizationId: orgId, name: `${firstNames[i]} Kumar`, phone: `90000000${(i + 10).toString().padStart(2, "0")}`, email: `${firstNames[i].toLowerCase()}@example.com` },
    });
    customers.push(c.id);
    const points = Math.floor(Math.random() * 500);
    await prisma.loyaltyAccount.create({ data: { organizationId: orgId, customerId: c.id, tier: points > 300 ? "GOLD" : "SILVER", pointsBalance: points } });
    if (points > 0) await prisma.loyaltyTransaction.create({ data: { organizationId: orgId, customerId: c.id, type: "EARN", points, note: "Historic earnings" } });
  }

  // ---------------- J/K. Procurement: PO -> GRN -> ledger, + bill + payment ----------------
  let poCount = 0, grnCount = 0, billCount = 0;
  const rawMaterials = materialDefs.filter((m) => !m.semi);
  for (const o of outlets) {
    // group a PO per vendor category for a handful of categories
    for (const cat of ["Grains", "Meat & Poultry", "Dairy", "Vegetables", "Spices", "Oils & Fats", "Beverages", "Bakery"]) {
      const mats = rawMaterials.filter((m) => m.cat === cat);
      if (mats.length === 0) continue;
      const vendorId = vendorForCat(cat);
      poCount++;
      const poNumber = `PO-${o.code}-${String(poCount).padStart(4, "0")}`;
      const poLines = mats.map((m) => ({ materialId: matByName[m.name].id, qty: m.reorder * 3, rate: m.rate, taxPct: m.tax }));
      const subtotal = poLines.reduce((a, l) => a + l.qty * l.rate, 0);
      const tax = poLines.reduce((a, l) => a + (l.qty * l.rate * l.taxPct) / 100, 0);
      const po = await prisma.purchaseOrder.create({
        data: {
          organizationId: orgId, outletId: o.id, number: poNumber, vendorId, status: "RECEIVED",
          subtotal, tax, total: subtotal + tax, approvedAt: new Date(),
          lines: { create: poLines.map((l) => ({ organizationId: orgId, materialId: l.materialId, qty: l.qty, rate: l.rate, taxPct: l.taxPct, receivedQty: l.qty })) },
        },
      });

      grnCount++;
      const grnNumber = `GRN-${o.code}-${String(grnCount).padStart(4, "0")}`;
      const grn = await prisma.goodsReceipt.create({
        data: {
          organizationId: orgId, outletId: o.id, number: grnNumber, poId: po.id, vendorId, status: "POSTED", postedAt: new Date(),
          lines: { create: mats.map((m) => ({ organizationId: orgId, materialId: matByName[m.name].id, qty: m.reorder * 3, rate: m.rate })) },
        },
      });
      // Post to inventory ledger via the real service (GRN -> ledger chain)
      for (const m of mats) {
        await recordPurchaseReceipt(ctx, {
          outletId: o.id, materialId: matByName[m.name].id, quantity: m.reorder * 3, rate: m.rate,
          departmentId: deptByOutlet[o.id].STORE, sourceId: grn.id, sourceRef: `grn:${grn.id}:${matByName[m.name].id}`,
        });
      }

      // Purchase bill (some partially paid => vendor dues)
      billCount++;
      const paid = Math.random() > 0.5 ? (subtotal + tax) : (subtotal + tax) * 0.5;
      const bill = await prisma.purchaseBill.create({
        data: {
          organizationId: orgId, outletId: o.id, number: `BILL-${o.code}-${String(billCount).padStart(4, "0")}`, vendorId, grnId: grn.id,
          subtotal, tax, total: subtotal + tax, paidAmount: paid, status: paid >= subtotal + tax ? "PAID" : "PARTIAL",
          lines: { create: mats.map((m) => ({ organizationId: orgId, materialId: matByName[m.name].id, qty: m.reorder * 3, rate: m.rate, taxPct: m.tax })) },
        },
      });
      if (paid > 0) await prisma.vendorPayment.create({ data: { organizationId: orgId, outletId: o.id, vendorId, billId: bill.id, amount: paid, method: "BANK", reference: `TXN${Math.floor(Math.random() * 1e8)}` } });
    }
  }

  // ---------------- M. Production (consume raw -> output semi-finished) ----------------
  // Produce Ginger Garlic Paste at Central: consume ginger+garlic, output SF-GGP.
  {
    const o = outletCentral;
    const batch = await prisma.productionBatch.create({
      data: { organizationId: orgId, outletId: o.id, number: `PROD-${o.code}-0001`, outputMaterialId: matByName["Ginger Garlic Paste"].id, plannedQty: 2, actualQty: 2, status: "COMPLETED", completedAt: new Date(),
        lines: { create: [{ organizationId: orgId, materialId: matByName["Ginger"].id, qty: 1 }, { organizationId: orgId, materialId: matByName["Garlic"].id, qty: 1 }] } },
    });
    await recordProductionConsumption(ctx, { outletId: o.id, materialId: matByName["Ginger"].id, quantity: 1, sourceId: batch.id, sourceRef: `prod:${batch.id}:ginger` });
    await recordProductionConsumption(ctx, { outletId: o.id, materialId: matByName["Garlic"].id, quantity: 1, sourceId: batch.id, sourceRef: `prod:${batch.id}:garlic` });
    // Output cost per unit ~ (cost of inputs)/output qty
    const cost = (rateByName["Ginger"] * 1 + rateByName["Garlic"] * 1) / 2;
    await recordProductionOutput(ctx, { outletId: o.id, materialId: matByName["Ginger Garlic Paste"].id, quantity: 2, rate: cost, batchNo: "GGP-001", sourceId: batch.id, sourceRef: `prod:${batch.id}:output` });
  }

  // ---------------- N/O/P. Sample dine-in orders -> KOT -> payment -> explosion -> consumption ----------------
  const dineInPlan = [
    { outlet: outletCentral, items: [["M001", 2], ["M030", 3], ["M050", 2]] },
    { outlet: outletCentral, items: [["M010", 1], ["M011", 1], ["M040", 1], ["M051", 2]] },
    { outlet: outletCentral, items: [["M002", 1], ["M020", 1], ["M030", 2]] },
    { outlet: outletJubilee, items: [["M003", 2], ["M012", 1], ["M041", 1]] },
    { outlet: outletJubilee, items: [["M010", 2], ["M030", 4], ["M050", 1]] },
    { outlet: outletJubilee, items: [["M020", 2], ["M051", 3]] },
  ] as const;

  let orderCount = 0, kotCount = 0, paymentCount = 0;
  for (let i = 0; i < dineInPlan.length; i++) {
    const plan = dineInPlan[i];
    const table = await prisma.restaurantTable.findFirst({ where: { outletId: plan.outlet.id }, orderBy: { code: "asc" }, skip: i % 4 });
    const order = await createOrder(ctx, { outletId: plan.outlet.id, channel: "DINE_IN", source: "POS", tableId: table?.id, customerId: customers[i], covers: 2 });
    orderCount++;
    for (const [code, qty] of plan.items) {
      await addOrderItem(ctx, order.id, { menuItemId: menuByCode[code as string], qty: qty as number });
    }
    await submitOrder(ctx, order.id);
    const kots = await prisma.$transaction((tx) => createKOTsForOrder(tx, ctx, order.id));
    kotCount += kots.length;
    // advance one KOT through the KDS lifecycle
    if (kots[0]) {
      await prisma.kot.update({ where: { id: kots[0].id }, data: { status: "READY" } });
    }
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    const payment = await createPayment(ctx, order.id, { method: i % 2 === 0 ? "CASH" : "UPI", amount: Number(fresh!.total) });
    paymentCount++;
    await verifyPayment(ctx, payment.id); // -> SUCCESS -> order PAID -> recipe explosion -> consumption
  }

  // A refunded order to exercise refund -> payment/order state
  {
    const order = await createOrder(ctx, { outletId: outletCentral.id, channel: "TAKEAWAY", source: "POS", customerId: customers[7] });
    await addOrderItem(ctx, order.id, { menuItemId: menuByCode.M001, qty: 1 });
    await submitOrder(ctx, order.id);
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    const p = await createPayment(ctx, order.id, { method: "CARD", amount: Number(fresh!.total) });
    await verifyPayment(ctx, p.id);
    const { refundPayment } = await import("@/server/services/payment");
    await refundPayment(ctx, p.id, { amount: Number(fresh!.total), reason: "Customer complaint" });
    orderCount++; paymentCount++;
  }

  // ---------------- POS mock webhook -> idempotency -> consumption (+ unmapped) ----------------
  const provider = new MockPOSProvider();
  // Tenant binding (H4): the provider's store id maps to this outlet; webhooks never pick their tenant from the body.
  await prisma.integrationConnection.create({ data: { organizationId: org.id, outletId: outletCentral.id, kind: "POS", provider: "mock", externalRef: "PP-STORE-CENTRAL", status: "CONNECTED" } });
  const webhookPayload = {
    eventId: "PP-EVT-1001", externalRef: "PP-ORDER-5001", storeId: "PP-STORE-CENTRAL", source: "PETPOOJA", channel: "AGGREGATOR",
    placedAt: new Date().toISOString(),
    customer: { name: "Zomato Customer", phone: "9000000099" },
    items: [
      { posItemCode: "M001", name: "Chicken Biryani", qty: 2, unitPrice: 320, taxPct: 5 },
      { posItemCode: "M010", name: "Butter Chicken", qty: 1, unitPrice: 340, taxPct: 5 },
      { posItemCode: "ZZ999", name: "Mystery Combo", qty: 1, unitPrice: 199, taxPct: 5 }, // unmapped -> queue
    ],
    payments: [{ method: "ONLINE", amount: 1237.95, providerRef: "pay_zomato_1" }], // = lines 1179 + 5% GST 58.95
    settled: true,
  };
  const rawBody = JSON.stringify(webhookPayload);
  const signature = MockPOSProvider.sign(rawBody);
  const w1 = await receivePOSWebhook({ providerName: "mock", rawBody, signature }, { provider, db: prisma });
  const w2 = await receivePOSWebhook({ providerName: "mock", rawBody, signature }, { provider, db: prisma }); // duplicate
  console.log(`  POS webhook #1: ${JSON.stringify(w1)}`);
  console.log(`  POS webhook #2 (duplicate): ${JSON.stringify(w2)}`);

  // ---------------- Q. Wastage ----------------
  await recordWastage(ctx, { outletId: outletCentral.id, materialId: matByName["Tomato"].id, quantity: 2, departmentId: deptByOutlet[outletCentral.id].KITCHEN, note: "Spoiled overnight", sourceRef: `waste:seed:1` });
  await recordWastage(ctx, { outletId: outletCentral.id, materialId: matByName["Milk"].id, quantity: 1.5, departmentId: deptByOutlet[outletCentral.id].KITCHEN, note: "Curdled", sourceRef: `waste:seed:2` });
  await recordWastage(ctx, { outletId: outletJubilee.id, materialId: matByName["Coriander Leaves"].id, quantity: 0.5, note: "Wilted", sourceRef: `waste:seed:3` });
  const wastageDocs = 3;

  // ---------------- R. Stock counts + variance adjustment ----------------
  let countDocs = 0;
  {
    const o = outletCentral;
    const countMaterials = ["Basmati Rice", "Chicken", "Onion"];
    const count = await prisma.stockCount.create({ data: { organizationId: orgId, outletId: o.id, number: `SC-${o.code}-0001`, status: "APPROVED", frozenAt: new Date(), approvedAt: new Date() } });
    countDocs++;
    for (const name of countMaterials) {
      const book = await currentQuantity(prisma, ctx, o.id, matByName[name].id);
      const physical = Number(book) - (name === "Onion" ? 1.5 : 0); // onion short by 1.5
      const variance = physical - Number(book);
      await prisma.stockCountLine.create({ data: { organizationId: orgId, countId: count.id, materialId: matByName[name].id, bookQty: Number(book), physicalQty: physical, variance, costImpact: variance * rateByName[name] } });
      if (variance !== 0) await recordCountAdjustment(ctx, { outletId: o.id, materialId: matByName[name].id, variance, sourceId: count.id, sourceRef: `count:${count.id}:${matByName[name].id}`, note: "Physical count variance" });
    }
  }

  // ---------------- S. Reservations + waitlist ----------------
  let reservationCount = 0;
  for (let i = 0; i < 4; i++) {
    await prisma.reservation.create({ data: { organizationId: orgId, outletId: i % 2 ? outletJubilee.id : outletCentral.id, customerId: customers[i], partySize: 2 + i, reservedAt: new Date(Date.now() + (i + 1) * 3600_000), status: i === 3 ? "CONFIRMED" : "BOOKED" } });
    reservationCount++;
  }
  await prisma.waitlistEntry.create({ data: { organizationId: orgId, outletId: outletCentral.id, customerName: "Walk-in Group", partySize: 5, estWaitMins: 20 } });

  // ---------------- T. Expenses / petty cash / reconciliation ----------------
  for (const o of outlets) {
    await prisma.expense.create({ data: { organizationId: orgId, outletId: o.id, category: "UTILITIES", amount: 4500, description: "Electricity", paidVia: "BANK" } });
    await prisma.expense.create({ data: { organizationId: orgId, outletId: o.id, category: "REPAIRS", amount: 1200, description: "AC service", paidVia: "PETTY_CASH" } });
    await prisma.pettyCashTxn.create({ data: { organizationId: orgId, outletId: o.id, type: "OPENING", amount: 5000, reason: "Opening float" } });
    await prisma.pettyCashTxn.create({ data: { organizationId: orgId, outletId: o.id, type: "EXPENSE", amount: -1200, category: "REPAIRS", reason: "AC service" } });

    // reconciliation for today from actual successful payments
    const grouped = await prisma.payment.groupBy({ by: ["method"], where: { outletId: o.id, status: "SUCCESS" }, _sum: { amount: true } });
    const recon = await prisma.reconciliation.create({ data: { organizationId: orgId, outletId: o.id, businessDate: new Date(new Date().toDateString()), status: "COMPLETED" } });
    for (const g of grouped) {
      const expected = Number(g._sum.amount ?? 0);
      await prisma.reconciliationLine.create({ data: { organizationId: orgId, reconciliationId: recon.id, method: g.method, expected, actual: expected, difference: 0 } });
    }
  }

  // ---------------- People: shifts / attendance / tasks ----------------
  const storeUser = await prisma.user.findFirst({ where: { email: "store@demo.local" } });
  await prisma.shift.create({ data: { organizationId: orgId, outletId: outletCentral.id, name: "Morning", startTime: "09:00", endTime: "17:00" } });
  await prisma.shift.create({ data: { organizationId: orgId, outletId: outletCentral.id, name: "Evening", startTime: "16:00", endTime: "00:00" } });
  if (storeUser) await prisma.attendance.create({ data: { organizationId: orgId, outletId: outletCentral.id, userId: storeUser.id, checkIn: new Date(Date.now() - 6 * 3600_000), status: "PRESENT" } });
  await prisma.task.create({ data: { organizationId: orgId, outletId: outletCentral.id, title: "Opening checklist", description: "Fridge temp, gas, cleanliness", priority: "HIGH", status: "OPEN" } });
  await prisma.task.create({ data: { organizationId: orgId, outletId: outletCentral.id, title: "Closing checklist", priority: "MEDIUM", status: "OPEN" } });

  // ---------------- U. Notifications + integration connections ----------------
  await prisma.notification.create({ data: { organizationId: orgId, outletId: outletCentral.id, channel: "IN_APP", type: "LOW_STOCK", title: "Low stock alert", body: "Some items are near reorder level" } });
  await prisma.integrationConnection.create({ data: { organizationId: orgId, outletId: outletCentral.id, kind: "POS", provider: "petpooja", status: "DISCONNECTED", config: JSON.stringify({ note: "Set PETPOOJA_APP_KEY to connect" }) } });

  // ---------------- Summary ----------------
  const counts = {
    organizations: await prisma.organization.count(),
    outlets: await prisma.outlet.count(),
    departments: await prisma.department.count(),
    users: await prisma.user.count(),
    memberships: await prisma.membership.count(),
    units: await prisma.unit.count(),
    materials: await prisma.material.count(),
    vendors: await prisma.vendor.count(),
    vendorMaterials: await prisma.vendorMaterial.count(),
    menuItems: await prisma.menuItem.count(),
    recipes: await prisma.recipe.count(),
    recipeVersions: await prisma.recipeVersion.count(),
    recipeLines: await prisma.recipeLine.count(),
    tables: await prisma.restaurantTable.count(),
    customers: await prisma.customer.count(),
    purchaseOrders: await prisma.purchaseOrder.count(),
    goodsReceipts: await prisma.goodsReceipt.count(),
    purchaseBills: await prisma.purchaseBill.count(),
    vendorPayments: await prisma.vendorPayment.count(),
    inventoryLedgerRows: await prisma.inventoryLedger.count(),
    productionBatches: await prisma.productionBatch.count(),
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
    kots: await prisma.kot.count(),
    payments: await prisma.payment.count(),
    refunds: await prisma.refund.count(),
    webhookEvents: await prisma.webhookEvent.count(),
    unmappedSales: await prisma.unmappedSale.count(),
    anomalies: await prisma.anomaly.count(),
    wastages: await prisma.inventoryLedger.count({ where: { txnType: "WASTAGE" } }),
    stockCounts: await prisma.stockCount.count(),
    reservations: await prisma.reservation.count(),
    expenses: await prisma.expense.count(),
    reconciliations: await prisma.reconciliation.count(),
    auditLogs: await prisma.auditLog.count(),
  };

  console.log("\n=== SEED COMPLETE ===");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`\nDemo login: owner@demo.local .. cashier@demo.local  password: ${DEMO_PASSWORD}`);
  void wastageDocs; void countDocs; void reservationCount; void kotCount; void poCount; void grnCount; void billCount; void orderCount; void paymentCount;
}

main()
  .then(async () => { await prisma.$disconnect(); })
  .catch(async (e) => { console.error("SEED FAILED:", e); await prisma.$disconnect(); process.exit(1); });
