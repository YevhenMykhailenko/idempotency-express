import { MAX_REDIS_RECORD_BYTES, MAX_REDIS_RESPONSE_BYTES } from "./redis-data.js";

/** One-key atomic transitions. No local lock, read-before-claim, release, or TTL extension. */
export const REDIS_TRANSITION = `
local key = KEYS[1]
local operation = ARGV[1]
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local maxInteger = 9007199254740991

local function load()
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return {missing = true} end
  if kind ~= 'string' or redis.call('STRLEN', key) > ${MAX_REDIS_RECORD_BYTES} then
    return {invalid = true}
  end
  local raw = redis.call('GET', key)
  if not raw then return {missing = true} end
  local fields = {}
  local offset = 1
  for i = 1, 5 do
    local ending = string.find(raw, '\\n', offset, true)
    if not ending or ending - offset > 128 then return {invalid = true} end
    fields[i] = string.sub(raw, offset, ending - 1)
    offset = ending + 1
  end
  local version, state, fp, token, expiry = unpack(fields)
  if version ~= '1' or (state ~= 'inflight' and state ~= 'completed') or
      #fp ~= 64 or string.find(fp, '[^0-9a-f]') or #token == 0 or
      #token > 128 or string.find(token, '[^!-~]') or #expiry > 16 or
      not string.match(expiry, '^[1-9][0-9]*$') then return {invalid = true} end
  local deadline = tonumber(expiry)
  if deadline > maxInteger or string.format('%.0f', deadline) ~= expiry or
      redis.call('PEXPIRETIME', key) ~= deadline then return {invalid = true} end
  local response = string.sub(raw, offset)
  if (state == 'inflight' and response ~= '') or
      (state == 'completed' and (#response == 0 or #response > ${MAX_REDIS_RESPONSE_BYTES})) then
    return {invalid = true}
  end
  if deadline <= now then return {missing = true} end
  return {raw = raw, state = state, fp = fp, token = token, expiry = expiry}
end

local deadline
if operation == 'begin' then
  deadline = now + tonumber(ARGV[3])
  if deadline > maxInteger or deadline <= now then return {'range'} end
end
local current = load()
if current.invalid then return {'invalid'} end
if operation == 'begin' then
  if not current.missing then return {'entry', current.raw} end
  local expiry = string.format('%.0f', deadline)
  local raw = '1\\ninflight\\n' .. ARGV[2] .. '\\n' .. ARGV[4] .. '\\n' .. expiry .. '\\n'
  redis.call('SET', key, raw, 'PXAT', expiry)
  return {'started', ARGV[4], expiry}
end
if current.missing then return {'missing'} end
if operation == 'read' or current.state == 'completed' then return {'entry', current.raw} end
if current.fp ~= ARGV[2] or current.token ~= ARGV[3] then return {'reservation-lost'} end
local raw = '1\\ncompleted\\n' .. current.fp .. '\\n' .. current.token .. '\\n' .. current.expiry .. '\\n' .. ARGV[4]
redis.call('SET', key, raw, 'XX', 'KEEPTTL')
return {'committed'}
`;
