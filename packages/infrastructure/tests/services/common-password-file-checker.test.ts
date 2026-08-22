import { readFileSync } from 'node:fs';
import {
  CommonPasswordFileChecker,
  createCommonPasswordChecker,
} from '../../src/services/common-password-file-checker';

// The file read is the only I/O this adapter performs, so it is mocked outright: the behaviour under
// test is how the file's CONTENT becomes set membership, not whether the disk works.
jest.mock('node:fs', () => ({
  __esModule: true,
  readFileSync: jest.fn(),
}));

const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

const DEFAULT_PATH = '/srv/data/common-passwords.txt';

/** Builds a checker over a synthetic password file made of the given lines. */
function createChecker(lines: string[], filePath: string = DEFAULT_PATH): CommonPasswordFileChecker {
  mockReadFileSync.mockReturnValue(lines.join('\n'));
  return new CommonPasswordFileChecker(filePath);
}

describe('CommonPasswordFileChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('file loading', () => {
    test('reads the given path as utf8 text', () => {
      createChecker(['password']);

      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
      expect(mockReadFileSync).toHaveBeenCalledWith(DEFAULT_PATH, 'utf8');
    });

    test('reads the file exactly once, not once per lookup', () => {
      const checker = createChecker(['password', 'letmein']);
      mockReadFileSync.mockClear();

      checker.isCommon('password');
      checker.isCommon('letmein');
      checker.isCommon('absent');

      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    test('keeps the snapshot taken at construction when the file later changes', () => {
      const checker = createChecker(['password']);
      mockReadFileSync.mockReturnValue('hunter2');

      expect(checker.isCommon('password')).toBe(true);
      expect(checker.isCommon('hunter2')).toBe(false);
    });

    test('propagates a read failure instead of degrading to an empty list', () => {
      // Silently treating an unreadable file as "no common passwords" would disable the check
      // altogether, so the failure has to surface at construction.
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory, open '/srv/data/common-passwords.txt'");
      });

      expect(() => new CommonPasswordFileChecker(DEFAULT_PATH)).toThrow('ENOENT');
    });
  });

  describe('normalisation of the loaded file', () => {
    test('lower-cases entries so a mixed-case line matches any casing', () => {
      const checker = createChecker(['PassWord']);

      expect(checker.isCommon('password')).toBe(true);
      expect(checker.isCommon('PASSWORD')).toBe(true);
      expect(checker.isCommon('PassWord')).toBe(true);
    });

    test('trims surrounding whitespace from entries', () => {
      const checker = createChecker(['   letmein\t']);

      expect(checker.isCommon('letmein')).toBe(true);
    });

    test('strips the carriage return of a CRLF-terminated file', () => {
      mockReadFileSync.mockReturnValue('password\r\nletmein\r\n');
      const checker = new CommonPasswordFileChecker(DEFAULT_PATH);

      expect(checker.isCommon('password')).toBe(true);
      expect(checker.isCommon('letmein')).toBe(true);
      expect(checker.isCommon('letmein\r')).toBe(false);
    });

    test('drops blank and whitespace-only lines so the empty string is never a member', () => {
      // Without the length filter, a trailing newline alone would make "" a common password and
      // every empty submission would be rejected with the wrong reason.
      const checker = createChecker(['password', '', '   ', '\t', 'letmein', '']);

      expect(checker.isCommon('')).toBe(false);
      expect(checker.isCommon('   ')).toBe(false);
      expect(checker.isCommon('\t')).toBe(false);
      expect(checker.isCommon('password')).toBe(true);
      expect(checker.isCommon('letmein')).toBe(true);
    });

    test('keeps whitespace inside an entry', () => {
      const checker = createChecker(['let me in']);

      expect(checker.isCommon('let me in')).toBe(true);
      expect(checker.isCommon('letmein')).toBe(false);
    });

    test('loads every line of the file, not just the first', () => {
      const checker = createChecker(['first', 'second', 'third', 'fourth']);

      expect(checker.isCommon('first')).toBe(true);
      expect(checker.isCommon('second')).toBe(true);
      expect(checker.isCommon('third')).toBe(true);
      expect(checker.isCommon('fourth')).toBe(true);
    });

    test('treats an empty file as an empty list', () => {
      mockReadFileSync.mockReturnValue('');
      const checker = new CommonPasswordFileChecker(DEFAULT_PATH);

      expect(checker.isCommon('')).toBe(false);
      expect(checker.isCommon('password')).toBe(false);
    });
  });

  describe('isCommon', () => {
    test('lower-cases the queried password before looking it up', () => {
      const checker = createChecker(['password']);

      expect(checker.isCommon('PaSsWoRd')).toBe(true);
    });

    test('rejects a password that is not in the file', () => {
      const checker = createChecker(['password', 'letmein', '123456']);

      expect(checker.isCommon('a-passphrase-nobody-uses')).toBe(false);
    });

    test('does not trim the queried password', () => {
      // Membership is exact after lower-casing: " password " is a genuinely different password and
      // the checker must not claim to have seen it.
      const checker = createChecker(['password']);

      expect(checker.isCommon(' password ')).toBe(false);
      expect(checker.isCommon('password ')).toBe(false);
    });

    test('does not match on a substring or a prefix', () => {
      const checker = createChecker(['password']);

      expect(checker.isCommon('passwor')).toBe(false);
      expect(checker.isCommon('password1')).toBe(false);
      expect(checker.isCommon('mypassword')).toBe(false);
    });
  });
});

describe('createCommonPasswordChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFileSync.mockReturnValue('password\nletmein\n');
  });

  test('reads common-passwords.txt from the given data directory', () => {
    createCommonPasswordChecker('/srv/data');

    expect(mockReadFileSync).toHaveBeenCalledWith('/srv/data/common-passwords.txt', 'utf8');
  });

  test('normalises a trailing separator on the data directory', () => {
    createCommonPasswordChecker('/srv/data/');

    expect(mockReadFileSync).toHaveBeenCalledWith('/srv/data/common-passwords.txt', 'utf8');
  });

  test('resolves the file relative to the directory it is given', () => {
    createCommonPasswordChecker('/opt/app/assets');

    expect(mockReadFileSync).toHaveBeenCalledWith('/opt/app/assets/common-passwords.txt', 'utf8');
  });

  test('returns a working checker over that file', () => {
    const checker = createCommonPasswordChecker('/srv/data');

    expect(checker).toBeInstanceOf(CommonPasswordFileChecker);
    expect(checker.isCommon('letmein')).toBe(true);
    expect(checker.isCommon('unlisted')).toBe(false);
  });
});
