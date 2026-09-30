export const PERMISSIONS = {
  DASHBOARD_VIEW: 'dashboard:view',
  CLIENT_VIEW: 'client:view',
  CLIENT_MANAGE: 'client:manage',
  SITE_VIEW: 'site:view',
  SITE_MANAGE: 'site:manage',
  PRODUCT_VIEW: 'product:view',
  PRODUCT_MANAGE: 'product:manage',
  PRODUCT_COST_VIEW: 'product:cost_view',
  PRODUCT_PRICE_OVERRIDE: 'product:price_override',
  VENDOR_VIEW: 'vendor:view',
  VENDOR_MANAGE: 'vendor:manage',
  QUOTATION_VIEW: 'quotation:view',
  QUOTATION_MANAGE: 'quotation:manage',
  QUOTATION_APPROVE: 'quotation:approve',
  PROJECT_VIEW: 'project:view',
  PROJECT_MANAGE: 'project:manage',
  PROJECT_PROGRESS: 'project:progress',
  INVOICE_VIEW: 'invoice:view',
  INVOICE_MANAGE: 'invoice:manage',
  PAYMENT_VIEW: 'payment:view',
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_VOID: 'payment:void',
  LEDGER_VIEW: 'ledger:view',
  EXPENSE_VIEW: 'expense:view',
  EXPENSE_MANAGE: 'expense:manage',
  PURCHASE_VIEW: 'purchase:view',
  PURCHASE_MANAGE: 'purchase:manage',
  INVENTORY_VIEW: 'inventory:view',
  INVENTORY_MANAGE: 'inventory:manage',
  REPORT_VIEW: 'report:view',
  SETTINGS_MANAGE: 'settings:manage',
  USER_MANAGE: 'user:manage',
  AUDIT_VIEW: 'audit:view',
  BACKUP_MANAGE: 'backup:manage',
  IMPORT_EXPORT: 'data:import_export',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];
export const WILDCARD = '*';

const P = PERMISSIONS;

export const DEFAULT_ROLES: Record<string, { description: string; permissions: string[] }> = {
  Admin: { description: 'Full system access', permissions: [WILDCARD] },
  Sales: {
    description: 'Manage clients and quotations; view projects',
    permissions: [
      P.DASHBOARD_VIEW, P.CLIENT_VIEW, P.CLIENT_MANAGE, P.SITE_VIEW, P.SITE_MANAGE, P.PRODUCT_VIEW,
      P.QUOTATION_VIEW, P.QUOTATION_MANAGE, P.PROJECT_VIEW, P.INVENTORY_VIEW,
    ],
  },
  Accounts: {
    description: 'Invoices, payments, ledgers, expenses and reports',
    permissions: [
      P.DASHBOARD_VIEW, P.CLIENT_VIEW, P.SITE_VIEW, P.PRODUCT_VIEW, P.PRODUCT_COST_VIEW, P.QUOTATION_VIEW,
      P.PROJECT_VIEW, P.INVOICE_VIEW, P.INVOICE_MANAGE, P.PAYMENT_VIEW, P.PAYMENT_CREATE, P.PAYMENT_VOID,
      P.LEDGER_VIEW, P.EXPENSE_VIEW, P.EXPENSE_MANAGE, P.REPORT_VIEW, P.VENDOR_VIEW, P.PURCHASE_VIEW,
      P.IMPORT_EXPORT,
    ],
  },
  Procurement: {
    description: 'Vendors, purchase orders and stock',
    permissions: [
      P.DASHBOARD_VIEW, P.PRODUCT_VIEW, P.PRODUCT_COST_VIEW, P.VENDOR_VIEW, P.VENDOR_MANAGE, P.PURCHASE_VIEW,
      P.PURCHASE_MANAGE, P.INVENTORY_VIEW, P.INVENTORY_MANAGE, P.PROJECT_VIEW,
    ],
  },
  'Project Manager': {
    description: 'Project progress, site spaces and installation status',
    permissions: [
      P.DASHBOARD_VIEW, P.CLIENT_VIEW, P.SITE_VIEW, P.SITE_MANAGE, P.PRODUCT_VIEW, P.PROJECT_VIEW,
      P.PROJECT_PROGRESS, P.INVENTORY_VIEW,
    ],
  },
};

export function hasPermission(granted: string[], required: string): boolean {
  return granted.includes(WILDCARD) || granted.includes(required);
}
