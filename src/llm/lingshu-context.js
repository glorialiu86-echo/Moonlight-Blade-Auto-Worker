export const LINGSHU_GAMEPLAY_CONTEXT = "灵枢绘世可走世缘、生金、势力几条路：能送礼、搭讪、约会、切磋刷好感，也能摆摊、交易、炒股、拍卖赚钱；黑活要先潜行，再做闷棍、妙取、下毒、种蛊。百草可炼药，蛊主可制蛊，干坏事被发现会掉秩序值、被通缉坐牢。";

const LINGSHU_SCRIPT_KEYS = new Set([
  "sell_loop",
  "social_warm",
  "social_dark",
  "dark_close",
  "dark_miaoqu",
  "ending_trade"
]);

const LINGSHU_SCENES = new Set([
  "town_dialogue",
  "market_trade",
  "field_patrol",
  "jail_warning"
]);

function containsLingshuKeyword(value) {
  return String(value || "").includes("灵枢");
}

export function shouldInjectLingshuGameplayContext({
  interactionMode = "",
  scene = "",
  sceneLabel = "",
  scriptKey = "",
  instruction = ""
} = {}) {
  if (interactionMode === "watch") {
    return true;
  }

  if (LINGSHU_SCRIPT_KEYS.has(String(scriptKey || "").trim())) {
    return true;
  }

  if (LINGSHU_SCENES.has(String(scene || "").trim())) {
    return true;
  }

  return containsLingshuKeyword(sceneLabel) || containsLingshuKeyword(instruction);
}
