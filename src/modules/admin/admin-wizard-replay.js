export function isOlderAdminWizardReplay(ctx,wizard){
  const updateId=Number(ctx?.update?.update_id);
  const lastUpdateId=wizard?.lastUpdateId;
  return Boolean(
    ctx?.state?.durableReplay&&
    Number.isSafeInteger(updateId)&&
    Number.isSafeInteger(lastUpdateId)&&
    updateId<=lastUpdateId
  );
}
