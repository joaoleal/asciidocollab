// The root route never renders anything — it only decides where to send the visitor. The mocked
// redirect() does not throw the way Next's real one does, so each case asserts on the destination
// the page asked for.
import Home from '@/app/page';

const mockGetSession = jest.fn();
jest.mock('@/lib/auth', () => ({
  getSession: () => mockGetSession(),
}));

const mockSetupStatus = jest.fn();
jest.mock('@/lib/api', () => ({
  authApi: {
    setupStatus: () => mockSetupStatus(),
  },
}));

const mockRedirect = jest.fn();
jest.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));

describe('Home', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSession.mockResolvedValue(null);
    mockSetupStatus.mockResolvedValue({ configured: true });
  });

  test('sends a signed-in visitor to the dashboard', async () => {
    mockGetSession.mockResolvedValue({ userId: 'u1' });
    await Home();
    expect(mockRedirect).toHaveBeenCalledWith('/dashboard');
  });

  test('sends an anonymous visitor to first-run setup when the install is unconfigured', async () => {
    mockSetupStatus.mockResolvedValue({ configured: false });
    await Home();
    expect(mockRedirect).toHaveBeenCalledWith('/register');
  });

  test('sends an anonymous visitor to the login page on a configured install', async () => {
    await Home();
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockRedirect).not.toHaveBeenCalledWith('/dashboard');
  });
});
