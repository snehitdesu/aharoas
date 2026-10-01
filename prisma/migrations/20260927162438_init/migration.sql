-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "gstin" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Outlet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "gstin" TEXT,
    "phone" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "openTime" TEXT,
    "closeTime" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Outlet_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'OTHER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Department_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "outletId" TEXT,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Membership_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Unit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COUNT',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UnitConversion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "fromUnitId" TEXT NOT NULL,
    "toUnitId" TEXT NOT NULL,
    "factor" DECIMAL NOT NULL,
    "materialId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MaterialCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryId" TEXT,
    "baseUnitId" TEXT NOT NULL,
    "purchaseUnitId" TEXT,
    "taxPct" DECIMAL NOT NULL DEFAULT 0,
    "minStock" DECIMAL NOT NULL DEFAULT 0,
    "reorderLevel" DECIMAL NOT NULL DEFAULT 0,
    "preferredVendorId" TEXT,
    "perishable" BOOLEAN NOT NULL DEFAULT false,
    "trackBatch" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Material_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MaterialCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Material_baseUnitId_fkey" FOREIGN KEY ("baseUnitId") REFERENCES "Unit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OutletMaterialCost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "avgCost" DECIMAL NOT NULL DEFAULT 0,
    "lastCost" DECIMAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutletMaterialCost_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "gstin" TEXT,
    "bankAccount" TEXT,
    "bankIfsc" TEXT,
    "paymentTerms" TEXT,
    "creditLimit" DECIMAL NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "VendorMaterial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "lastRate" DECIMAL NOT NULL DEFAULT 0,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 1,
    "preferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorMaterial_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VendorMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL NOT NULL DEFAULT 0,
    "taxPct" DECIMAL NOT NULL DEFAULT 5,
    "station" TEXT NOT NULL DEFAULT 'KITCHEN',
    "posCode" TEXT,
    "isVeg" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "soldOut" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuItemVariant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" DECIMAL NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "MenuItemVariant_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minSelect" INTEGER NOT NULL DEFAULT 0,
    "maxSelect" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "ModifierOption" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" DECIMAL NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "ModifierOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuItemModifierGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "menuItemId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    CONSTRAINT "MenuItemModifierGroup_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MenuItemModifierGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outputType" TEXT NOT NULL DEFAULT 'MENU_ITEM',
    "menuItemId" TEXT,
    "outputMaterialId" TEXT,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Recipe_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecipeVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "yieldQty" DECIMAL NOT NULL DEFAULT 1,
    "yieldUnitId" TEXT,
    "servingSize" DECIMAL NOT NULL DEFAULT 1,
    "notes" TEXT,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecipeVersion_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecipeLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "recipeVersionId" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "materialId" TEXT,
    "subRecipeId" TEXT,
    "qty" DECIMAL NOT NULL,
    "unitId" TEXT,
    "wastagePct" DECIMAL NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RecipeLine_recipeVersionId_fkey" FOREIGN KEY ("recipeVersionId") REFERENCES "RecipeVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RecipeLine_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RecipeLine_subRecipeId_fkey" FOREIGN KEY ("subRecipeId") REFERENCES "Recipe" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Floor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Floor_outletId_fkey" FOREIGN KEY ("outletId") REFERENCES "Outlet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RestaurantTable" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "floorId" TEXT,
    "code" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "qrToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RestaurantTable_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "Floor" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "birthday" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CustomerAddress" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Home',
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT,
    "pincode" TEXT,
    "lat" REAL,
    "lng" REAL,
    CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'SILVER',
    "pointsBalance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "LoyaltyAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "orderId" TEXT,
    "note" TEXT,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoyaltyTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "customerId" TEXT,
    "orderId" TEXT,
    "rating" INTEGER NOT NULL DEFAULT 5,
    "comment" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Feedback_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "customerId" TEXT,
    "tableId" TEXT,
    "partySize" INTEGER NOT NULL DEFAULT 2,
    "reservedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BOOKED',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reservation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "phone" TEXT,
    "partySize" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "estWaitMins" INTEGER NOT NULL DEFAULT 15,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'DINE_IN',
    "source" TEXT NOT NULL DEFAULT 'POS',
    "externalRef" TEXT,
    "tableId" TEXT,
    "customerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "invoiceNo" TEXT,
    "subtotal" DECIMAL NOT NULL DEFAULT 0,
    "discount" DECIMAL NOT NULL DEFAULT 0,
    "tax" DECIMAL NOT NULL DEFAULT 0,
    "total" DECIMAL NOT NULL DEFAULT 0,
    "stockConsumed" BOOLEAN NOT NULL DEFAULT false,
    "covers" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "createdById" TEXT,
    "billedAt" DATETIME,
    "paidAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "RestaurantTable" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT,
    "posItemCode" TEXT,
    "name" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL NOT NULL DEFAULT 0,
    "discount" DECIMAL NOT NULL DEFAULT 0,
    "taxPct" DECIMAL NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL NOT NULL DEFAULT 0,
    "station" TEXT NOT NULL DEFAULT 'KITCHEN',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrderItemModifier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" DECIMAL NOT NULL DEFAULT 0,
    CONSTRAINT "OrderItemModifier_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL NOT NULL,
    "providerRef" TEXT,
    "provider" TEXT,
    "verifiedAt" DATETIME,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KitchenStation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'KITCHEN',
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "Kot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "stationId" TEXT,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "printedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Kot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Kot_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "KitchenStation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KotItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kotId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "name" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    CONSTRAINT "KotItem_kotId_fkey" FOREIGN KEY ("kotId") REFERENCES "Kot" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "KotItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseIndent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "departmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PurchaseIndentLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "indentId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "unitId" TEXT,
    CONSTRAINT "PurchaseIndentLine_indentId_fkey" FOREIGN KEY ("indentId") REFERENCES "PurchaseIndent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "expectedDate" DATETIME,
    "subtotal" DECIMAL NOT NULL DEFAULT 0,
    "tax" DECIMAL NOT NULL DEFAULT 0,
    "total" DECIMAL NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "rate" DECIMAL NOT NULL,
    "taxPct" DECIMAL NOT NULL DEFAULT 0,
    "receivedQty" DECIMAL NOT NULL DEFAULT 0,
    "unitId" TEXT,
    CONSTRAINT "PurchaseOrderLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoodsReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "poId" TEXT,
    "vendorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdById" TEXT,
    "postedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GoodsReceipt_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GoodsReceiptLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "grnId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "rate" DECIMAL NOT NULL,
    "damagedQty" DECIMAL NOT NULL DEFAULT 0,
    "batchNo" TEXT,
    "expiryDate" DATETIME,
    "unitId" TEXT,
    CONSTRAINT "GoodsReceiptLine_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GoodsReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseBill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "grnId" TEXT,
    "billDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueDate" DATETIME,
    "subtotal" DECIMAL NOT NULL DEFAULT 0,
    "tax" DECIMAL NOT NULL DEFAULT 0,
    "total" DECIMAL NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PurchaseBill_grnId_fkey" FOREIGN KEY ("grnId") REFERENCES "GoodsReceipt" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PurchaseBillLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "rate" DECIMAL NOT NULL,
    "taxPct" DECIMAL NOT NULL DEFAULT 0,
    CONSTRAINT "PurchaseBillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VendorPayment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "billId" TEXT,
    "amount" DECIMAL NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'BANK',
    "reference" TEXT,
    "paidAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VendorPayment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "PurchaseBill" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "departmentId" TEXT,
    "materialId" TEXT NOT NULL,
    "unitId" TEXT,
    "txnType" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "rate" DECIMAL NOT NULL DEFAULT 0,
    "amount" DECIMAL NOT NULL DEFAULT 0,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "sourceRef" TEXT,
    "batchNo" TEXT,
    "expiryDate" DATETIME,
    "note" TEXT,
    "correctionOfId" TEXT,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryLedger_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InventoryLedger_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InventoryLedger_correctionOfId_fkey" FOREIGN KEY ("correctionOfId") REFERENCES "InventoryLedger" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryTransfer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fromOutletId" TEXT NOT NULL,
    "toOutletId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT,
    "dispatchedAt" DATETIME,
    "receivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "InventoryTransferLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "requestedQty" DECIMAL NOT NULL,
    "dispatchedQty" DECIMAL NOT NULL DEFAULT 0,
    "receivedQty" DECIMAL NOT NULL DEFAULT 0,
    "damagedQty" DECIMAL NOT NULL DEFAULT 0,
    "unitId" TEXT,
    CONSTRAINT "InventoryTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "InventoryTransfer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InventoryIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "fromDepartmentId" TEXT,
    "toDepartmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT,
    "issuedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "InventoryIssueLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "unitId" TEXT,
    CONSTRAINT "InventoryIssueLine_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "InventoryIssue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Wastage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "departmentId" TEXT,
    "number" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'SPOILAGE',
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "WastageLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "wastageId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "estCost" DECIMAL NOT NULL DEFAULT 0,
    "unitId" TEXT,
    CONSTRAINT "WastageLine_wastageId_fkey" FOREIGN KEY ("wastageId") REFERENCES "Wastage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "departmentId" TEXT,
    "number" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "frozenAt" DATETIME,
    "approvedById" TEXT,
    "approvedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "bookQty" DECIMAL NOT NULL DEFAULT 0,
    "physicalQty" DECIMAL NOT NULL DEFAULT 0,
    "variance" DECIMAL NOT NULL DEFAULT 0,
    "costImpact" DECIMAL NOT NULL DEFAULT 0,
    "unitId" TEXT,
    CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductionBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "recipeVersionId" TEXT,
    "outputMaterialId" TEXT NOT NULL,
    "plannedQty" DECIMAL NOT NULL,
    "actualQty" DECIMAL NOT NULL DEFAULT 0,
    "batchNo" TEXT,
    "expiryDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ProductionLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "unitId" TEXT,
    CONSTRAINT "ProductionLine_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ProductionBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "description" TEXT,
    "paidVia" TEXT NOT NULL DEFAULT 'CASH',
    "attachmentUrl" TEXT,
    "spentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PettyCashTxn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL NOT NULL,
    "category" TEXT,
    "reason" TEXT,
    "attachmentUrl" TEXT,
    "approvedById" TEXT,
    "actorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "CashDrawerSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "openedById" TEXT,
    "openingFloat" DECIMAL NOT NULL DEFAULT 0,
    "closingCount" DECIMAL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "businessDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ReconciliationLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "expected" DECIMAL NOT NULL DEFAULT 0,
    "actual" DECIMAL NOT NULL DEFAULT 0,
    "difference" DECIMAL NOT NULL DEFAULT 0,
    "note" TEXT,
    CONSTRAINT "ReconciliationLine_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "Reconciliation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Aggregator" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "commissionPct" DECIMAL NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "AggregatorOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "orderId" TEXT,
    "grossAmount" DECIMAL NOT NULL DEFAULT 0,
    "discount" DECIMAL NOT NULL DEFAULT 0,
    "commission" DECIMAL NOT NULL DEFAULT 0,
    "tax" DECIMAL NOT NULL DEFAULT 0,
    "platformFee" DECIMAL NOT NULL DEFAULT 0,
    "netPayout" DECIMAL NOT NULL DEFAULT 0,
    "placedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AggregatorOrder_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Aggregator" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AggregatorSettlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "aggregatorId" TEXT NOT NULL,
    "periodFrom" DATETIME NOT NULL,
    "periodTo" DATETIME NOT NULL,
    "expectedPayout" DECIMAL NOT NULL DEFAULT 0,
    "actualPayout" DECIMAL NOT NULL DEFAULT 0,
    "difference" DECIMAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AggregatorSettlement_aggregatorId_fkey" FOREIGN KEY ("aggregatorId") REFERENCES "Aggregator" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "checkIn" DATETIME NOT NULL,
    "checkOut" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'PRESENT',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromDate" DATETIME NOT NULL,
    "toDate" DATETIME NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "assignedToId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dueAt" DATETIME,
    "completedById" TEXT,
    "completedAt" DATETIME,
    "verifiedById" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT,
    "signatureValid" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "payload" TEXT NOT NULL,
    "error" TEXT,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "UnmappedSale" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT NOT NULL,
    "posCode" TEXT NOT NULL,
    "posName" TEXT,
    "qty" DECIMAL NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'POS',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "mappedMenuItemId" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" DATETIME,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "IntegrationConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DISCONNECTED',
    "config" TEXT,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "direction" TEXT,
    "detail" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "kind" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'CSV',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "filePath" TEXT,
    "requestedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Anomaly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "departmentId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
    "entityType" TEXT,
    "entityId" TEXT,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolutionNote" TEXT,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "userId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'IN_APP',
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "outletId" TEXT,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "before" TEXT,
    "after" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Organization_active_idx" ON "Organization"("active");

-- CreateIndex
CREATE INDEX "Outlet_organizationId_active_idx" ON "Outlet"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Outlet_organizationId_code_key" ON "Outlet"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Department_organizationId_idx" ON "Department"("organizationId");

-- CreateIndex
CREATE INDEX "Department_outletId_kind_idx" ON "Department"("outletId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Department_outletId_name_key" ON "Department"("outletId", "name");

-- CreateIndex
CREATE INDEX "User_organizationId_active_idx" ON "User"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");

-- CreateIndex
CREATE INDEX "Membership_outletId_idx" ON "Membership"("outletId");

-- CreateIndex
CREATE INDEX "Membership_userId_active_idx" ON "Membership"("userId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_userId_outletId_role_key" ON "Membership"("userId", "outletId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Unit_organizationId_idx" ON "Unit"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Unit_organizationId_code_key" ON "Unit"("organizationId", "code");

-- CreateIndex
CREATE INDEX "UnitConversion_organizationId_idx" ON "UnitConversion"("organizationId");

-- CreateIndex
CREATE INDEX "UnitConversion_materialId_idx" ON "UnitConversion"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "UnitConversion_organizationId_fromUnitId_toUnitId_materialId_key" ON "UnitConversion"("organizationId", "fromUnitId", "toUnitId", "materialId");

-- CreateIndex
CREATE INDEX "MaterialCategory_organizationId_idx" ON "MaterialCategory"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialCategory_organizationId_name_key" ON "MaterialCategory"("organizationId", "name");

-- CreateIndex
CREATE INDEX "Material_organizationId_active_idx" ON "Material"("organizationId", "active");

-- CreateIndex
CREATE INDEX "Material_categoryId_idx" ON "Material"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Material_organizationId_sku_key" ON "Material"("organizationId", "sku");

-- CreateIndex
CREATE INDEX "OutletMaterialCost_organizationId_idx" ON "OutletMaterialCost"("organizationId");

-- CreateIndex
CREATE INDEX "OutletMaterialCost_materialId_idx" ON "OutletMaterialCost"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "OutletMaterialCost_outletId_materialId_key" ON "OutletMaterialCost"("outletId", "materialId");

-- CreateIndex
CREATE INDEX "Vendor_organizationId_active_idx" ON "Vendor"("organizationId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_organizationId_name_key" ON "Vendor"("organizationId", "name");

-- CreateIndex
CREATE INDEX "VendorMaterial_organizationId_idx" ON "VendorMaterial"("organizationId");

-- CreateIndex
CREATE INDEX "VendorMaterial_materialId_idx" ON "VendorMaterial"("materialId");

-- CreateIndex
CREATE UNIQUE INDEX "VendorMaterial_vendorId_materialId_key" ON "VendorMaterial"("vendorId", "materialId");

-- CreateIndex
CREATE INDEX "MenuCategory_organizationId_idx" ON "MenuCategory"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuCategory_organizationId_name_key" ON "MenuCategory"("organizationId", "name");

-- CreateIndex
CREATE INDEX "MenuItem_organizationId_active_idx" ON "MenuItem"("organizationId", "active");

-- CreateIndex
CREATE INDEX "MenuItem_organizationId_posCode_idx" ON "MenuItem"("organizationId", "posCode");

-- CreateIndex
CREATE INDEX "MenuItem_categoryId_idx" ON "MenuItem"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItem_organizationId_name_key" ON "MenuItem"("organizationId", "name");

-- CreateIndex
CREATE INDEX "MenuItemVariant_organizationId_idx" ON "MenuItemVariant"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemVariant_menuItemId_name_key" ON "MenuItemVariant"("menuItemId", "name");

-- CreateIndex
CREATE INDEX "ModifierGroup_organizationId_idx" ON "ModifierGroup"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierGroup_organizationId_name_key" ON "ModifierGroup"("organizationId", "name");

-- CreateIndex
CREATE INDEX "ModifierOption_organizationId_idx" ON "ModifierOption"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "ModifierOption_groupId_name_key" ON "ModifierOption"("groupId", "name");

-- CreateIndex
CREATE INDEX "MenuItemModifierGroup_groupId_idx" ON "MenuItemModifierGroup"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemModifierGroup_menuItemId_groupId_key" ON "MenuItemModifierGroup"("menuItemId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_menuItemId_key" ON "Recipe"("menuItemId");

-- CreateIndex
CREATE INDEX "Recipe_organizationId_active_idx" ON "Recipe"("organizationId", "active");

-- CreateIndex
CREATE INDEX "Recipe_outputMaterialId_idx" ON "Recipe"("outputMaterialId");

-- CreateIndex
CREATE INDEX "RecipeVersion_organizationId_idx" ON "RecipeVersion"("organizationId");

-- CreateIndex
CREATE INDEX "RecipeVersion_recipeId_status_idx" ON "RecipeVersion"("recipeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeVersion_recipeId_version_key" ON "RecipeVersion"("recipeId", "version");

-- CreateIndex
CREATE INDEX "RecipeLine_recipeVersionId_idx" ON "RecipeLine"("recipeVersionId");

-- CreateIndex
CREATE INDEX "RecipeLine_organizationId_idx" ON "RecipeLine"("organizationId");

-- CreateIndex
CREATE INDEX "RecipeLine_materialId_idx" ON "RecipeLine"("materialId");

-- CreateIndex
CREATE INDEX "RecipeLine_subRecipeId_idx" ON "RecipeLine"("subRecipeId");

-- CreateIndex
CREATE INDEX "Floor_organizationId_idx" ON "Floor"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Floor_outletId_name_key" ON "Floor"("outletId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_qrToken_key" ON "RestaurantTable"("qrToken");

-- CreateIndex
CREATE INDEX "RestaurantTable_organizationId_outletId_idx" ON "RestaurantTable"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "RestaurantTable_outletId_status_idx" ON "RestaurantTable"("outletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_outletId_code_key" ON "RestaurantTable"("outletId", "code");

-- CreateIndex
CREATE INDEX "Customer_organizationId_idx" ON "Customer"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_organizationId_phone_key" ON "Customer"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "CustomerAddress_customerId_idx" ON "CustomerAddress"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyAccount_customerId_key" ON "LoyaltyAccount"("customerId");

-- CreateIndex
CREATE INDEX "LoyaltyAccount_organizationId_idx" ON "LoyaltyAccount"("organizationId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_organizationId_idx" ON "LoyaltyTransaction"("organizationId");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_customerId_idx" ON "LoyaltyTransaction"("customerId");

-- CreateIndex
CREATE INDEX "Feedback_organizationId_idx" ON "Feedback"("organizationId");

-- CreateIndex
CREATE INDEX "Feedback_customerId_idx" ON "Feedback"("customerId");

-- CreateIndex
CREATE INDEX "Reservation_organizationId_outletId_idx" ON "Reservation"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "Reservation_outletId_reservedAt_idx" ON "Reservation"("outletId", "reservedAt");

-- CreateIndex
CREATE INDEX "WaitlistEntry_organizationId_outletId_status_idx" ON "WaitlistEntry"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "Order_organizationId_outletId_createdAt_idx" ON "Order"("organizationId", "outletId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_outletId_status_idx" ON "Order"("outletId", "status");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_outletId_source_externalRef_key" ON "Order"("outletId", "source", "externalRef");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_organizationId_outletId_idx" ON "OrderItem"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "OrderItem_menuItemId_idx" ON "OrderItem"("menuItemId");

-- CreateIndex
CREATE INDEX "OrderItemModifier_orderItemId_idx" ON "OrderItemModifier"("orderItemId");

-- CreateIndex
CREATE INDEX "Payment_organizationId_outletId_createdAt_idx" ON "Payment"("organizationId", "outletId", "createdAt");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerRef_key" ON "Payment"("provider", "providerRef");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Refund_organizationId_outletId_idx" ON "Refund"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "KitchenStation_organizationId_outletId_idx" ON "KitchenStation"("organizationId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "KitchenStation_outletId_name_key" ON "KitchenStation"("outletId", "name");

-- CreateIndex
CREATE INDEX "Kot_organizationId_outletId_status_idx" ON "Kot"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "Kot_orderId_idx" ON "Kot"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Kot_outletId_number_key" ON "Kot"("outletId", "number");

-- CreateIndex
CREATE INDEX "KotItem_kotId_idx" ON "KotItem"("kotId");

-- CreateIndex
CREATE INDEX "PurchaseIndent_organizationId_outletId_status_idx" ON "PurchaseIndent"("organizationId", "outletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseIndent_outletId_number_key" ON "PurchaseIndent"("outletId", "number");

-- CreateIndex
CREATE INDEX "PurchaseIndentLine_indentId_idx" ON "PurchaseIndentLine"("indentId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_organizationId_outletId_status_idx" ON "PurchaseOrder"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "PurchaseOrder_vendorId_idx" ON "PurchaseOrder"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_outletId_number_key" ON "PurchaseOrder"("outletId", "number");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_poId_idx" ON "PurchaseOrderLine"("poId");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_materialId_idx" ON "PurchaseOrderLine"("materialId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_organizationId_outletId_status_idx" ON "GoodsReceipt"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "GoodsReceipt_vendorId_idx" ON "GoodsReceipt"("vendorId");

-- CreateIndex
CREATE INDEX "GoodsReceipt_poId_idx" ON "GoodsReceipt"("poId");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_outletId_number_key" ON "GoodsReceipt"("outletId", "number");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_grnId_idx" ON "GoodsReceiptLine"("grnId");

-- CreateIndex
CREATE INDEX "GoodsReceiptLine_materialId_idx" ON "GoodsReceiptLine"("materialId");

-- CreateIndex
CREATE INDEX "PurchaseBill_organizationId_outletId_status_idx" ON "PurchaseBill"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "PurchaseBill_vendorId_idx" ON "PurchaseBill"("vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseBill_outletId_number_key" ON "PurchaseBill"("outletId", "number");

-- CreateIndex
CREATE INDEX "PurchaseBillLine_billId_idx" ON "PurchaseBillLine"("billId");

-- CreateIndex
CREATE INDEX "VendorPayment_organizationId_outletId_idx" ON "VendorPayment"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "VendorPayment_vendorId_idx" ON "VendorPayment"("vendorId");

-- CreateIndex
CREATE INDEX "VendorPayment_billId_idx" ON "VendorPayment"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLedger_sourceRef_key" ON "InventoryLedger"("sourceRef");

-- CreateIndex
CREATE INDEX "InventoryLedger_organizationId_outletId_materialId_idx" ON "InventoryLedger"("organizationId", "outletId", "materialId");

-- CreateIndex
CREATE INDEX "InventoryLedger_materialId_createdAt_idx" ON "InventoryLedger"("materialId", "createdAt");

-- CreateIndex
CREATE INDEX "InventoryLedger_outletId_txnType_idx" ON "InventoryLedger"("outletId", "txnType");

-- CreateIndex
CREATE INDEX "InventoryLedger_sourceType_sourceId_idx" ON "InventoryLedger"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "InventoryTransfer_organizationId_status_idx" ON "InventoryTransfer"("organizationId", "status");

-- CreateIndex
CREATE INDEX "InventoryTransfer_fromOutletId_idx" ON "InventoryTransfer"("fromOutletId");

-- CreateIndex
CREATE INDEX "InventoryTransfer_toOutletId_idx" ON "InventoryTransfer"("toOutletId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryTransfer_organizationId_number_key" ON "InventoryTransfer"("organizationId", "number");

-- CreateIndex
CREATE INDEX "InventoryTransferLine_transferId_idx" ON "InventoryTransferLine"("transferId");

-- CreateIndex
CREATE INDEX "InventoryTransferLine_materialId_idx" ON "InventoryTransferLine"("materialId");

-- CreateIndex
CREATE INDEX "InventoryIssue_organizationId_outletId_status_idx" ON "InventoryIssue"("organizationId", "outletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryIssue_outletId_number_key" ON "InventoryIssue"("outletId", "number");

-- CreateIndex
CREATE INDEX "InventoryIssueLine_issueId_idx" ON "InventoryIssueLine"("issueId");

-- CreateIndex
CREATE INDEX "InventoryIssueLine_materialId_idx" ON "InventoryIssueLine"("materialId");

-- CreateIndex
CREATE INDEX "Wastage_organizationId_outletId_idx" ON "Wastage"("organizationId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "Wastage_outletId_number_key" ON "Wastage"("outletId", "number");

-- CreateIndex
CREATE INDEX "WastageLine_wastageId_idx" ON "WastageLine"("wastageId");

-- CreateIndex
CREATE INDEX "WastageLine_materialId_idx" ON "WastageLine"("materialId");

-- CreateIndex
CREATE INDEX "StockCount_organizationId_outletId_status_idx" ON "StockCount"("organizationId", "outletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockCount_outletId_number_key" ON "StockCount"("outletId", "number");

-- CreateIndex
CREATE INDEX "StockCountLine_countId_idx" ON "StockCountLine"("countId");

-- CreateIndex
CREATE INDEX "StockCountLine_materialId_idx" ON "StockCountLine"("materialId");

-- CreateIndex
CREATE INDEX "ProductionBatch_organizationId_outletId_status_idx" ON "ProductionBatch"("organizationId", "outletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductionBatch_outletId_number_key" ON "ProductionBatch"("outletId", "number");

-- CreateIndex
CREATE INDEX "ProductionLine_batchId_idx" ON "ProductionLine"("batchId");

-- CreateIndex
CREATE INDEX "ProductionLine_materialId_idx" ON "ProductionLine"("materialId");

-- CreateIndex
CREATE INDEX "Expense_organizationId_outletId_spentAt_idx" ON "Expense"("organizationId", "outletId", "spentAt");

-- CreateIndex
CREATE INDEX "PettyCashTxn_organizationId_outletId_createdAt_idx" ON "PettyCashTxn"("organizationId", "outletId", "createdAt");

-- CreateIndex
CREATE INDEX "CashDrawerSession_organizationId_outletId_status_idx" ON "CashDrawerSession"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "Reconciliation_organizationId_outletId_idx" ON "Reconciliation"("organizationId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "Reconciliation_outletId_businessDate_key" ON "Reconciliation"("outletId", "businessDate");

-- CreateIndex
CREATE INDEX "ReconciliationLine_reconciliationId_idx" ON "ReconciliationLine"("reconciliationId");

-- CreateIndex
CREATE INDEX "Aggregator_organizationId_idx" ON "Aggregator"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Aggregator_organizationId_name_key" ON "Aggregator"("organizationId", "name");

-- CreateIndex
CREATE INDEX "AggregatorOrder_organizationId_outletId_idx" ON "AggregatorOrder"("organizationId", "outletId");

-- CreateIndex
CREATE UNIQUE INDEX "AggregatorOrder_aggregatorId_externalId_key" ON "AggregatorOrder"("aggregatorId", "externalId");

-- CreateIndex
CREATE INDEX "AggregatorSettlement_organizationId_outletId_idx" ON "AggregatorSettlement"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "Attendance_organizationId_outletId_userId_idx" ON "Attendance"("organizationId", "outletId", "userId");

-- CreateIndex
CREATE INDEX "Attendance_userId_checkIn_idx" ON "Attendance"("userId", "checkIn");

-- CreateIndex
CREATE INDEX "Shift_organizationId_outletId_idx" ON "Shift"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "LeaveRequest_organizationId_outletId_userId_idx" ON "LeaveRequest"("organizationId", "outletId", "userId");

-- CreateIndex
CREATE INDEX "Task_organizationId_outletId_status_idx" ON "Task"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "Task_assignedToId_idx" ON "Task"("assignedToId");

-- CreateIndex
CREATE INDEX "WebhookEvent_status_idx" ON "WebhookEvent"("status");

-- CreateIndex
CREATE INDEX "WebhookEvent_provider_receivedAt_idx" ON "WebhookEvent"("provider", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "UnmappedSale_organizationId_outletId_status_idx" ON "UnmappedSale"("organizationId", "outletId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "UnmappedSale_outletId_source_posCode_key" ON "UnmappedSale"("outletId", "source", "posCode");

-- CreateIndex
CREATE INDEX "IntegrationConnection_organizationId_idx" ON "IntegrationConnection"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConnection_organizationId_outletId_kind_provider_key" ON "IntegrationConnection"("organizationId", "outletId", "kind", "provider");

-- CreateIndex
CREATE INDEX "SyncJob_organizationId_kind_status_idx" ON "SyncJob"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "ExportJob_organizationId_kind_idx" ON "ExportJob"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "Anomaly_organizationId_outletId_status_idx" ON "Anomaly"("organizationId", "outletId", "status");

-- CreateIndex
CREATE INDEX "Anomaly_type_severity_idx" ON "Anomaly"("type", "severity");

-- CreateIndex
CREATE INDEX "Notification_organizationId_outletId_idx" ON "Notification"("organizationId", "outletId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_outletId_createdAt_idx" ON "AuditLog"("organizationId", "outletId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");
