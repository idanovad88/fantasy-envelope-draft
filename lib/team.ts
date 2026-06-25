// Shared "my team" resolution helper.
// A team is "mine" if I am the owner (user_id) OR the assistant manager (assistant_user_id).
// Use as: supabase.from('teams').select('*').or(myTeamOr(user.id)).eq('league_id', ...)
export const myTeamOr = (userId: string) =>
  `user_id.eq.${userId},assistant_user_id.eq.${userId}`
