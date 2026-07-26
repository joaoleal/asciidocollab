import {
  RELPOS_LENGTH_PREFIX_BYTES,
  packRelativePositionPair,
  unpackRelativePositionPair,
} from '../../src/review/relative-position-pair';
import * as shared from '../../src/index';

describe('relative-position-pair', () => {
  test('round-trips both byte runs', () => {
    const start = new Uint8Array([1, 2, 3, 4, 5]);
    const end = new Uint8Array([9, 8]);

    const unpacked = unpackRelativePositionPair(packRelativePositionPair(start, end));

    expect(unpacked).not.toBeNull();
    expect([...unpacked!.start]).toEqual([1, 2, 3, 4, 5]);
    expect([...unpacked!.end]).toEqual([9, 8]);
  });

  test('writes the start length as a little-endian uint32 prefix', () => {
    const packed = packRelativePositionPair(new Uint8Array([7, 7, 7]), new Uint8Array([1]));

    expect(packed.length).toBe(RELPOS_LENGTH_PREFIX_BYTES + 4);
    expect([...packed.subarray(0, RELPOS_LENGTH_PREFIX_BYTES)]).toEqual([3, 0, 0, 0]);
  });

  test('round-trips empty runs on both sides', () => {
    const unpacked = unpackRelativePositionPair(
      packRelativePositionPair(new Uint8Array(), new Uint8Array()),
    );

    expect(unpacked).toEqual({ start: new Uint8Array(), end: new Uint8Array() });
  });

  test('unpacks correctly from a non-zero byteOffset view', () => {
    // The stored blob often arrives as a Node Buffer sharing a pooled ArrayBuffer, so the DataView
    // must be built over the view's own window rather than the whole underlying buffer.
    const packed = packRelativePositionPair(new Uint8Array([4, 5]), new Uint8Array([6]));
    const padded = new Uint8Array(packed.length + 8);
    padded.set(packed, 8);

    const unpacked = unpackRelativePositionPair(padded.subarray(8));

    expect([...unpacked!.start]).toEqual([4, 5]);
    expect([...unpacked!.end]).toEqual([6]);
  });

  test('returns null when the blob is too short to hold the length prefix', () => {
    expect(unpackRelativePositionPair(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(unpackRelativePositionPair(new Uint8Array())).toBeNull();
  });

  test('returns null when the length prefix overruns the blob', () => {
    const truncated = new Uint8Array(RELPOS_LENGTH_PREFIX_BYTES + 1);
    new DataView(truncated.buffer).setUint32(0, 99, true);

    expect(unpackRelativePositionPair(truncated)).toBeNull();
  });

  test('is re-exported from the package barrel', () => {
    expect(shared.packRelativePositionPair).toBe(packRelativePositionPair);
    expect(shared.unpackRelativePositionPair).toBe(unpackRelativePositionPair);
    expect(shared.RELPOS_LENGTH_PREFIX_BYTES).toBe(RELPOS_LENGTH_PREFIX_BYTES);
  });
});
