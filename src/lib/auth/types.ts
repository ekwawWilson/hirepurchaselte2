import type { Permission, RoleName } from '../constants/rbac';

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  roleId: string;
  roleName: RoleName;
  branchId: string | null;
  permissions: Permission[];
}
