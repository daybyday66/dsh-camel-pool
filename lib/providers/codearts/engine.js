// CodeArts 协议引擎：只读别名重导出。
// vendor/ 下四个文件是 dsh-codearts@1.3.0 的实测构建产物，未改动一字节；
// 本层只把 rolldown 的短别名翻译成可读名，驼峰适配层不直接碰短名。
export * as upstream from "./vendor/upstream-CVtspzAv.mjs";
export * as auth from "./vendor/auth-CF9XHMX-.mjs";
export * as version from "./vendor/version-CJTTrulR.mjs";

export const {
  C: prepareChatBody,
  r: chatStream,
  T: signedGet,
  t: SNAP_HOST,
  c: fetchModels,
  k: FALLBACK_CODEARTS_MODELS,
  n: canonicalModel,
  u: fetchWelfareCampaigns,
  S: pickDailyWelfareCampaign,
  i: claimDailyWelfare,
  l: fetchQueueStatus,
  a: clearQueueStatus,
  s: fetchCallerIdentity,
  E: upstreamErrorMessage,
  y: isWelfareClaimedStatus,
  b: maxTokensCeilingFor,
  R: modelDisplayName,
  L: mergeModelLists,
  M: filterEnabledModels,
  p: isIamTokenError,
  m: isModelNotAccessible,
  x: modelUnavailableReasonText,
  P: isBenefitBlocked,
  F: isBenefitModel,
  B: setDiscoveredBenefitModels,
  I: markModelUnavailable,
  N: forgetModelUnavailable,
  A: clearBenefitBlocked,
  O: CodeArtsCatalog,
  d: firstFrameError,
  w: rateLimitFrame,
  h: isNotMultimodal,
  v: isTpmLimit,
  f: isConcurrencyCap,
  g: isParamInvalidFrame,
  j: creditRatioLabel,
  z: modelUnavailableReason,
} = await import("./vendor/upstream-CVtspzAv.mjs");

export const {
  a: codeartsAuthPath,
  c: writeJsonAtomic,
  d: startLogin,
  i: codeartsAccountsPath,
  l: defaultLoginConfig,
  n: CodeArtsCredentialStore,
  o: credentialFromOAuth,
  r: MANUAL_ACCOUNT_ID,
  s: readAccountDocument,
  t: CodeArtsAccountStore,
  u: refreshToken,
} = await import("./vendor/auth-CF9XHMX-.mjs");

export const {
  a: refreshCatalog,
  i: discoverModels,
  n: CodeArtsUsageTracker,
  r: codeartsUsagePath,
  t: CODEARTS_VERSION,
} = await import("./vendor/version-CJTTrulR.mjs");
