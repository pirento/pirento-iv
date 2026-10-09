import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  ChevronRight,
  CreditCard,
  Eye,
  EyeOff,
  FileCheck2,
  FileText,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { api, sendJson } from '../../shared/api/api';
import type { AuthMessageResponse, AuthSessionResponse, AuthUser } from '../../../shared/auth-types';
import './auth.css';
import { changeLocation, ROUTE_EVENT, safeWorkspaceReturn } from '../../app/workspace-route';

type Page = 'home' | 'login' | 'signup' | 'forgot' | 'reset';
type Props = { children: (user: AuthUser, onLogout: () => Promise<void>) => ReactNode };
const businesses = [
  'Pirento legal',
  'Pirento ecosystem',
  'AT Facility',
  'A T Elevator',
  'INZARIO SPACE',
  'Shri Sarraf',
];
function route(): Page {
  if (window.location.pathname === '/reset-password' || window.location.hash.startsWith('#reset-password'))
    return 'reset';
  if (window.location.pathname === '/signup' || window.location.hash === '#signup') return 'signup';
  if (
    window.location.pathname === '/login' ||
    window.location.pathname.startsWith('/workspace/') ||
    window.location.hash === '#login'
  )
    return 'login';
  if (window.location.pathname === '/forgot-password' || window.location.hash === '#forgot-password')
    return 'forgot';
  return 'home';
}
function Brand({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="inv-brand" onClick={onClick} aria-label="Venturecore INV home">
      <span className="inv-monogram" aria-hidden="true">
        v<span>c</span>
        <i />
      </span>
      <span className="inv-wordmark">
        Venturecore <b>INV</b>
        <small>Solutions Private Limited</small>
      </span>
    </button>
  );
}
export default function AuthShell({ children }: Props) {
  const [page, setPage] = useState<Page>(route);
  const returnPath = useRef(safeWorkspaceReturn(window.location.pathname + window.location.search));
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);

  async function checkSession() {
    setChecking(true);
    setConnectionError('');
    try {
      setSession(await api<AuthSessionResponse>('/auth/me'));
    } catch (err) {
      setConnectionError(err instanceof Error ? err.message : 'Unable to connect to the workspace.');
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void checkSession();
  }, []);
  useEffect(() => {
    const hashChanged = () => {
      setPage(route());
      setError('');
      setNotice('');
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
    };
    const expired = () => {
      returnPath.current = safeWorkspaceReturn(window.location.pathname + window.location.search);
      setSession((current) => (current ? { ...current, user: null } : current));
      setPage('login');
      setPassword('');
      setConfirmPassword('');
      changeLocation('/login', true);
      setError('Your session has ended. Please log in again.');
    };
    window.addEventListener('hashchange', hashChanged);
    window.addEventListener('popstate', hashChanged);
    window.addEventListener(ROUTE_EVENT, hashChanged);
    window.addEventListener('venturecore:unauthorized', expired);
    window.addEventListener('vc-session-expired', expired);
    return () => {
      window.removeEventListener('hashchange', hashChanged);
      window.removeEventListener('popstate', hashChanged);
      window.removeEventListener(ROUTE_EVENT, hashChanged);
      window.removeEventListener('venturecore:unauthorized', expired);
      window.removeEventListener('vc-session-expired', expired);
    };
  }, []);
  useEffect(() => {
    if (!checking && !session?.user) heading.current?.focus();
  }, [page, checking, session?.user]);

  function navigate(next: Page, message = '') {
    setPage(next);
    setError('');
    setNotice(message);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    const path =
      next === 'home'
        ? '/'
        : next === 'forgot'
          ? '/forgot-password'
          : next === 'reset'
            ? `/reset-password${window.location.hash}`
            : `/${next}`;
    changeLocation(path);
    setNotice(message);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
  async function logout() {
    setError('');
    try {
      await api<AuthMessageResponse>('/auth/logout', sendJson('POST', {}));
      setSession((current) => (current ? { ...current, user: null } : current));
      returnPath.current = null;
      navigate('login', 'You have been logged out.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log out. Please try again.');
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setNotice('');
    if ((page === 'signup' || page === 'reset') && password !== confirmPassword) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (page === 'login') {
        const result = await api<{ user: AuthUser }>(
          '/auth/login',
          sendJson('POST', { email: email.trim(), password }),
        );
        setSession((current) => ({
          user: result.user,
          signupEnabled: current?.signupEnabled ?? false,
          passwordResetEnabled: current?.passwordResetEnabled ?? false,
        }));
        setPassword('');
        setPage('home');
        changeLocation(returnPath.current || '/', true);
        returnPath.current = null;
      } else if (page === 'signup') {
        const result = await api<AuthMessageResponse>(
          '/auth/signup',
          sendJson('POST', { name: name.trim(), email: email.trim(), password, company: company.trim() }),
        );
        navigate(
          'login',
          result.message ||
            'Your request has been submitted. An administrator must approve your account and assign organization access before you can log in.',
        );
      } else if (page === 'forgot') {
        const result = await api<AuthMessageResponse>(
          '/auth/forgot-password',
          sendJson('POST', { email: email.trim() }),
        );
        setNotice(
          result.message ||
            'If your account is eligible, password reset instructions will be emailed to you.',
        );
      } else if (page === 'reset') {
        const token =
          new URLSearchParams(
            window.location.hash.startsWith('#reset-password')
              ? window.location.hash.split('?')[1] || ''
              : window.location.hash.slice(1),
          ).get('token') || '';
        if (!token) throw new Error('This reset link is incomplete. Request a new password reset email.');
        const result = await api<AuthMessageResponse>(
          '/auth/reset-password',
          sendJson('POST', { token, password }),
        );
        setSession((current) => (current ? { ...current, user: null } : current));
        navigate('login', result.message || 'Your password has been updated. Log in with your new password.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (checking || connectionError || !session)
    return (
      <div className="inv-auth-loading">
        <Brand onClick={() => navigate('home')} />
        {checking ? (
          <>
            <LoaderCircle size={26} className="spin" />
            <p>Opening Venturecore INV…</p>
          </>
        ) : (
          <>
            <p role="alert">{connectionError || 'Unable to load the workspace.'}</p>
            <button className="inv-button inv-primary" onClick={() => void checkSession()}>
              Try again <ArrowRight size={16} />
            </button>
          </>
        )}
      </div>
    );
  if (session.user && page !== 'reset')
    return (
      <>
        {error && (
          <div className="inv-session-error" role="alert">
            {error}
            <button onClick={() => setError('')} aria-label="Dismiss session message">
              Dismiss
            </button>
          </div>
        )}
        {children(session.user, logout)}
      </>
    );

  const signup = page === 'signup';
  const resetting = page === 'reset';
  const forgot = page === 'forgot';
  const title = signup
    ? 'Your workspace starts here.'
    : resetting
      ? 'A fresh start for your password.'
      : forgot
        ? 'Let’s get you back in.'
        : 'Welcome back.';
  const subtitle = signup
    ? 'Request access to your team’s invoicing workspace.'
    : resetting
      ? 'Choose a new password to protect your account.'
      : forgot
        ? 'Enter your account email to request a password reset link.'
        : 'Log in to bring your business into focus.';
  return (
    <div className="inv-public">
      <header className="inv-public-header">
        <div className="inv-container inv-header-inner">
          <Brand onClick={() => navigate('home')} />
          <nav aria-label="Public navigation">
            <button
              type="button"
              className={`inv-nav-link ${page === 'home' ? 'current' : ''}`}
              onClick={() => navigate('home')}
            >
              Home
            </button>
            <button type="button" className="inv-nav-link" onClick={() => navigate('login')}>
              Log in
            </button>
            <button
              type="button"
              className="inv-button inv-primary inv-nav-signup"
              onClick={() => navigate('signup')}
            >
              Sign up <ArrowRight size={15} />
            </button>
          </nav>
        </div>
      </header>
      {page === 'home' ? (
        <main>
          <section className="inv-hero inv-container">
            <div className="inv-hero-copy">
              <div className="inv-kicker">
                <span /> EVERY BUSINESS. ITS OWN IDENTITY.
              </div>
              <h1 tabIndex={-1} ref={heading}>
                Good business.
                <br />
                <em>Beautifully organized.</em>
              </h1>
              <p>
                From the first quotation to the final payment, bring your customers, invoices and
                organizations together in Venturecore INV.
              </p>
              <div className="inv-hero-actions">
                <button className="inv-button inv-primary inv-large" onClick={() => navigate('login')}>
                  Open your workspace <ArrowRight size={18} />
                </button>
                <button className="inv-button inv-quiet inv-large" onClick={() => navigate('signup')}>
                  Request access <ChevronRight size={17} />
                </button>
              </div>
              <div className="inv-hero-detail">
                <ShieldCheck size={17} />
                <span>Team access, organized by your administrator.</span>
              </div>
            </div>
            <div className="inv-hero-visual" aria-hidden="true">
              <div className="inv-visual-orbit" />
              <div className="inv-visual-orbit second" />
              <span className="inv-visual-spark">✳</span>
              <div className="inv-paper">
                <div className="inv-paper-header">
                  <span className="inv-paper-logo">
                    v<span>c</span>
                  </span>
                  <span>
                    YOUR ORGANIZATION
                    <br />
                    <b>INVOICE</b>
                  </span>
                </div>
                <div className="inv-paper-intro">
                  <span>INVOICE TO</span>
                  <strong>Your customer</strong>
                  <i />
                  <i className="short" />
                </div>
                <div className="inv-paper-table">
                  <div>
                    <span>DESCRIPTION</span>
                    <span>AMOUNT</span>
                  </div>
                  <p>
                    <i />
                    <b />
                  </p>
                  <p>
                    <i />
                    <b />
                  </p>
                  <p>
                    <i />
                    <b />
                  </p>
                </div>
                <div className="inv-paper-total">
                  <span>
                    EVERY DETAIL.
                    <br />
                    <strong>In its place.</strong>
                  </span>
                  <span className="inv-paper-check">
                    <Check size={21} />
                  </span>
                </div>
                <span className="inv-sample-label">Illustrative document</span>
              </div>
              <div className="inv-floating-card inv-floating-top">
                <span>
                  <Layers3 size={21} />
                </span>
                <div>
                  One shared workspace<small>Each business, its own identity</small>
                </div>
              </div>
              <div className="inv-floating-card inv-floating-bottom">
                <span>
                  <FileCheck2 size={23} />
                </span>
                <div>
                  From draft to Paid / Final<small>Every payment stays on record</small>
                </div>
              </div>
            </div>
          </section>
          <section className="inv-divisions inv-container" aria-label="Workspace businesses and divisions">
            <span>VENTURECORE DIVISIONS & INDEPENDENT BUSINESSES</span>
            <div>
              {businesses.map((business) => (
                <span key={business}>
                  {business}
                  {business === 'Shri Sarraf' ? ' · Independent business' : ''}
                </span>
              ))}
            </div>
          </section>
          <section className="inv-feature-section inv-container">
            <div className="inv-section-heading">
              <span className="inv-kicker">A PLACE FOR THE WHOLE PICTURE</span>
              <h2>
                Less scattered.
                <br /> More connected.
              </h2>
              <p>The details that keep your business moving, together in a single workspace.</p>
            </div>
            <div className="inv-feature-grid">
              <article>
                <span className="inv-feature-icon">
                  <UsersRound size={24} />
                </span>
                <h3>Know your business contacts</h3>
                <p>
                  Save customers, vendors and B2B buyers for each organization, then search and select them
                  directly on your invoices.
                </p>
              </article>
              <article>
                <span className="inv-feature-icon">
                  <FileText size={24} />
                </span>
                <h3>Documents with your identity</h3>
                <p>
                  Create quotations, invoices and delivery challans with each business’s legal name, GST
                  registration, logo and signatures.
                </p>
              </article>
              <article>
                <span className="inv-feature-icon">
                  <CreditCard size={24} />
                </span>
                <h3>A clearer payment picture</h3>
                <p>
                  Track part payments, installment schedules and the balance due through to the final invoice.
                </p>
              </article>
            </div>
          </section>
          <section className="inv-home-cta inv-container">
            <span className="inv-cta-icon">
              <Building2 size={31} />
            </span>
            <div>
              <h2>One workspace. Room for every business.</h2>
              <p>Log in to your organizations, or request access from your administrator.</p>
            </div>
            <button className="inv-button inv-light" onClick={() => navigate('signup')}>
              Get started <ArrowRight size={17} />
            </button>
          </section>
        </main>
      ) : (
        <main className="inv-access-layout inv-container">
          <aside className="inv-access-story">
            <span className="inv-kicker">VENTURECORE INV</span>
            <h2>
              Every detail matters.
              <br />
              <em>Keep it together.</em>
            </h2>
            <p>Your businesses. Your contacts. Your next chapter.</p>
            <div className="inv-access-benefits">
              <div>
                <Building2 size={20} />
                <span>Separate business identities and records</span>
              </div>
              <div>
                <FileCheck2 size={20} />
                <span>Documents from quotation to final invoice</span>
              </div>
              <div>
                <LockKeyhole size={20} />
                <span>Access assigned to your team</span>
              </div>
            </div>
            <span className="inv-story-line" />
          </aside>
          <section className="inv-access-card">
            <button
              type="button"
              className="inv-back"
              onClick={() => navigate(forgot || resetting ? 'login' : 'home')}
            >
              <ArrowLeft size={15} />
              {forgot || resetting ? 'Back to log in' : 'Back to home'}
            </button>
            <div className="inv-form-icon">
              {forgot ? <Mail size={23} /> : signup ? <UsersRound size={23} /> : <LockKeyhole size={23} />}
            </div>
            <h1 tabIndex={-1} ref={heading}>
              {title}
            </h1>
            <p className="inv-access-subtitle">{subtitle}</p>
            {notice && (
              <div className="inv-form-notice" role="status">
                <Check size={17} />
                <span>{notice}</span>
              </div>
            )}
            {error && (
              <div className="inv-form-error" role="alert">
                {error}
              </div>
            )}
            {signup && !session.signupEnabled ? (
              <div className="inv-form-note">
                New account requests are currently closed. Contact your workspace administrator for access.
              </div>
            ) : forgot && !session.passwordResetEnabled ? (
              <div className="inv-form-note">
                Email password reset is not configured for this workspace yet. Contact your administrator to
                recover access.
              </div>
            ) : (
              <form onSubmit={submit} className="inv-auth-form">
                {signup && (
                  <label>
                    Full name
                    <input
                      name="name"
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={120}
                      placeholder="Your full name"
                      disabled={busy}
                    />
                  </label>
                )}
                {!resetting && (
                  <label>
                    Email address
                    <input
                      name="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      maxLength={254}
                      placeholder="you@company.com"
                      disabled={busy}
                    />
                  </label>
                )}
                {signup && (
                  <label>
                    Company / team <span className="inv-optional">Optional</span>
                    <input
                      name="company"
                      autoComplete="organization"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      maxLength={160}
                      placeholder="Your company or team"
                      disabled={busy}
                    />
                  </label>
                )}
                {!forgot && (
                  <>
                    <label>
                      {resetting ? 'New password' : 'Password'}
                      <span className="inv-password-input">
                        <input
                          name="password"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete={signup || resetting ? 'new-password' : 'current-password'}
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          required
                          minLength={signup || resetting ? 12 : 1}
                          maxLength={256}
                          placeholder={signup || resetting ? 'At least 12 characters' : 'Enter your password'}
                          disabled={busy}
                          aria-describedby={signup || resetting ? 'inv-password-hint' : undefined}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((current) => !current)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          aria-pressed={showPassword}
                        >
                          {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                      </span>
                    </label>
                    {(signup || resetting) && (
                      <>
                        <p id="inv-password-hint" className="inv-field-hint">
                          Use at least 12 characters. A longer, unique passphrase works well.
                        </p>
                        <label>
                          Confirm password
                          <input
                            name="confirmPassword"
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            required
                            minLength={12}
                            maxLength={256}
                            placeholder="Enter your password again"
                            disabled={busy}
                          />
                        </label>
                      </>
                    )}
                  </>
                )}
                {page === 'login' && (
                  <button type="button" className="inv-forgot-link" onClick={() => navigate('forgot')}>
                    Forgot password?
                  </button>
                )}
                {signup && (
                  <div className="inv-signup-note">
                    <ShieldCheck size={17} />
                    <p>
                      Your administrator will review your request and assign your organizations. Signing up
                      does not grant access to company records.
                    </p>
                  </div>
                )}
                <button type="submit" className="inv-button inv-primary inv-auth-submit" disabled={busy}>
                  {busy ? (
                    <>
                      <LoaderCircle size={17} className="spin" />
                      Please wait…
                    </>
                  ) : (
                    <>
                      {signup
                        ? 'Request account access'
                        : resetting
                          ? 'Update password'
                          : forgot
                            ? 'Send reset link'
                            : 'Log in'}
                      <ArrowRight size={17} />
                    </>
                  )}
                </button>
              </form>
            )}
            {!resetting && !forgot && (
              <p className="inv-auth-switch">
                {signup ? 'Already have an account?' : 'New to the workspace?'}{' '}
                <button type="button" onClick={() => navigate(signup ? 'login' : 'signup')}>
                  {signup ? 'Log in' : 'Sign up'}
                </button>
              </p>
            )}
          </section>
        </main>
      )}
      <footer className="inv-public-footer inv-container">
        <span>© {new Date().getFullYear()} Venturecore Solutions Private Limited</span>
        <span>
          <a href="mailto:support@pirento.com">Venturecore support</a> ·{' '}
          <a href="mailto:support@shrisarraf.com">Shri Sarraf support</a>
        </span>
      </footer>
    </div>
  );
}
