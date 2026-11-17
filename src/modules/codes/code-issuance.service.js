import {randomInt} from 'node:crypto';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
export const CODE_FINAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const MIN_SEQUENCE_NUMBER = 1;
export const MAX_SEQUENCE_NUMBER = 999999;

export function normalizeRequestedCodeCount(value) {
  if (typeof value === 'boolean' || value === null || value === undefined || (typeof value !== 'number' && typeof value !== 'string')) {
    throw new RangeError('Requested code count must be an integer between 1 and 100.');
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new RangeError('Requested code count must be an integer between 1 and 100.');
  }
  return count;
}

function randomCharacters(length) {
  if (!Number.isInteger(length) || length < 0 || length > 5) {
    throw new RangeError('Random prefix length must be between 0 and 5.');
  }
  if (length === 0) return '';
  let value = '';
  for (let i = 0; i < length - 1; i++) {
    value += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  value += (CODE_FINAL_ALPHABET + '0')[randomInt(CODE_FINAL_ALPHABET.length + 1)];
  return value;
}

function randomSuffix() {
  const first = CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const second = (CODE_FINAL_ALPHABET + '0')[randomInt(CODE_FINAL_ALPHABET.length + 1)];
  return first + second;
}

export function buildSequencePart(sequenceNumber, prefix) {
  const sequence = Number(sequenceNumber);
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE_NUMBER) {
    throw new RangeError('Sequence number must be between 1 and 999999.');
  }
  const digits = String(sequence);
  const expectedPrefixLength = 6 - digits.length;
  const normalizedPrefix = String(prefix);
  if (expectedPrefixLength < 0 || normalizedPrefix.length !== expectedPrefixLength) {
    throw new Error('Random prefix length does not match the six-character code segment.');
  }
  if (normalizedPrefix && !/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789]*[ABCDEFGHJKLMNPQRSTUVWXYZ0]$/.test(normalizedPrefix)) {
    throw new Error('Random prefix contains disallowed characters or an invalid final random character.');
  }
  return normalizedPrefix + digits;
}

export function formatCampaignCode({campaignId, sequenceNumber, randomPrefix, randomSuffix: suffix}) {
  const id = Number(campaignId);
  if (!Number.isSafeInteger(id) || id < 1) throw new RangeError('Campaign ID must be a positive integer.');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ0123456789][ABCDEFGHJKLMNPQRSTUVWXYZ0]$/.test(String(suffix))) {
    throw new Error('Random suffix must contain two allowed characters and end with an uppercase letter or 0.');
  }
  const middle = buildSequencePart(sequenceNumber, randomPrefix);
  return `P${id}-${middle}-${suffix}`;
}

export function generateCampaignCode({campaignId, sequenceNumber}) {
  const sequence = Number(sequenceNumber);
  if (!Number.isSafeInteger(sequence) || sequence < MIN_SEQUENCE_NUMBER || sequence > MAX_SEQUENCE_NUMBER) {
    throw new RangeError('Campaign sequence is outside the allowed issuance range.');
  }
  const prefix = randomCharacters(6 - String(sequence).length);
  const suffix = randomSuffix();
  return {
    code: formatCampaignCode({campaignId, sequenceNumber: sequence, randomPrefix: prefix, randomSuffix: suffix}),
    randomPrefix: prefix,
    randomSuffix: suffix
  };
}

// The caller must execute this function inside its existing MySQL transaction.
export async function issueCampaignCodes(connection, entryId, campaignId, requestedCount) {
  const count = normalizeRequestedCodeCount(requestedCount);
  await connection.execute(
    'INSERT IGNORE INTO campaign_code_counters(campaign_id,last_sequence) VALUES(?,0)',
    [campaignId]
  );
  const [[counter]] = await connection.execute(
    'SELECT last_sequence FROM campaign_code_counters WHERE campaign_id=? FOR UPDATE',
    [campaignId]
  );
  if (!counter) throw new Error('شمارنده کد کمپین پیدا نشد.');
  let lastSequence = Number(counter.last_sequence);
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0 || lastSequence > MAX_SEQUENCE_NUMBER) {
    throw new Error('وضعیت شمارنده کد کمپین نامعتبر است.');
  }
  if (lastSequence + count > MAX_SEQUENCE_NUMBER) {
    throw new Error('ظرفیت شماره‌گذاری کدهای این کمپین به پایان رسیده است.');
  }

  const codes = [];
  for (let index = 0; index < count; index++) {
    const sequenceNumber = ++lastSequence;
    const generated = generateCampaignCode({campaignId, sequenceNumber});
    await connection.execute(
      'INSERT INTO campaign_codes(campaign_entry_id,campaign_id,code,sequence_number,random_prefix,random_suffix,format_version,status) VALUES(?,?,?,?,?,?,2,\'active\')',
      [entryId, campaignId, generated.code, sequenceNumber, generated.randomPrefix, generated.randomSuffix]
    );
    codes.push(generated.code);
  }
  await connection.execute(
    'UPDATE campaign_code_counters SET last_sequence=?,updated_at=UTC_TIMESTAMP() WHERE campaign_id=?',
    [lastSequence, campaignId]
  );
  return codes;
}
