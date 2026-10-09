import type { ContactRole } from '../../shared/contact-types';

/** URL-serializable child pages shared by organization directories. */
export interface ManagerPage {
  action: 'new' | 'edit' | 'delete';
  id?: string;
  role?: ContactRole;
  itemType?: 'product' | 'service';
  suggestion?: string;
  businessProductId?: string;
}

export interface ManagerNavigation {
  page?: ManagerPage | null;
  onNavigate?: (page: ManagerPage | null) => void;
}
