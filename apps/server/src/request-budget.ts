import type { Store } from "./db.js";
/** Count before looking up a secret. A valid guess never bypasses an exhausted budget. */
export function takeRequestBudget(store:Store,scope:string,subject:string,limit:number,windowMs:number,now=Date.now()):boolean{
  const window=Math.floor(now/windowMs)*windowMs;
  const row=store.one<{attempts:number}>(`INSERT INTO request_budgets(scope,subject,window_start,attempts) VALUES(?,?,?,1)
    ON CONFLICT(scope,subject) DO UPDATE SET window_start=excluded.window_start,
      attempts=CASE WHEN request_budgets.window_start=excluded.window_start THEN request_budgets.attempts+1 ELSE 1 END RETURNING attempts`,scope,subject,window);
  store.run("DELETE FROM request_budgets WHERE window_start<?",now-24*60*60*1000);
  return Boolean(row&&row.attempts<=limit);
}
