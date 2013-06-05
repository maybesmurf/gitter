local key_socket_user = KEYS[1];
local key_active_users = KEYS[2];
local key_mobile_users = KEYS[3];
local key_active_sockets = KEYS[4];

local user_id = ARGV[1];
local socket_id = ARGV[2];
local create_time = ARGV[3];
local mobile_connection = ARGV[4];

if redis.call("EXISTS", key_socket_user) == 1 then
	return { 0 }
end

redis.call("HSET", key_socket_user, "uid", user_id)
redis.call("HSET", key_socket_user, "ctime", create_time)


local user_socket_count = -1

-- For mobile users, add them to the mobile users collection
if mobile_connection then
	redis.call("HSET", key_socket_user, "mob", 1)
	redis.call("ZINCRBY", key_mobile_users, 1, user_id)
else
	user_socket_count = redis.call("ZINCRBY", key_active_users, 1, user_id)
end

local socket_add_result = redis.call("SADD", key_active_sockets, socket_id)

return { 1, user_socket_count, socket_add_result }
