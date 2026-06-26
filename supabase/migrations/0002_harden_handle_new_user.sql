-- handle_new_user is only ever invoked by the on_auth_user_created trigger.
-- Triggers fire regardless of EXECUTE grants, so drop the default PUBLIC grant
-- that otherwise exposed it as a callable /rest/v1/rpc endpoint (security advisor warning).
revoke execute on function public.handle_new_user() from public, anon, authenticated;
