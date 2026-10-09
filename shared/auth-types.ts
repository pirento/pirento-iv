export type UserRole = 'admin' | 'staff';
export type UserStatus = 'pending' | 'active' | 'disabled';

/** Safe account data. Password hashes and session/reset tokens never leave the server. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  company: string;
  role: UserRole;
  status: UserStatus;
  organizationIds: string[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface AuthSessionResponse {
  user: AuthUser | null;
  signupEnabled: boolean;
  passwordResetEnabled: boolean;
}
export interface AuthMessageResponse {
  message: string;
}
export interface SignupInput {
  name: string;
  email: string;
  password: string;
  company?: string;
}
export interface LoginInput {
  email: string;
  password: string;
}
export interface UserAccessInput {
  role: UserRole;
  status: UserStatus;
  organizationIds: string[];
}
