import "../config/load-env.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transcribeWithAliyunAsr } from "../asr/aliyun-file-transcribe.js";
import { createAutoCaptureService } from "../capture/auto-capture-service.js";
import { captureGameWindow } from "../capture/windows-game-window.js";
import { analyzeImageWithHistory, generateText } from "../llm/qwen.js";
import {
  LINGSHU_GAMEPLAY_CONTEXT
} from "../llm/lingshu-context.js";
import { analyzeScreenshot } from "../perception/analyzer.js";
import { buildActionCatalog } from "../runtime/action-registry.js";
import {
  appendInteractionSample,
  buildInteractionSample,
  isInteractionPlan
} from "../runtime/interaction-learning.js";
import {
  appendMotionReviewSamples,
  buildMotionReviewSamples,
  triggerMotionReviewPass
} from "../runtime/motion-review.js";
import {
  createFixedSocialApproachActions,
  createFixedDarkCloseStageActions,
  createFixedEndingTradeActions,
  createFixedEndingTradeBundleActions,
  createFixedEndingTradeOpenTradeActions,
  createFixedEndingTradeRelocateActions,
  createFixedDarkMiaoquRecoveryActions,
  createFixedDarkMiaoquStageActions,
  createFixedSocialGiftActions,
  createFixedSocialGiftEntryActions,
  createFixedSocialGiftResolveActions,
  createFixedSellLoopActions,
  createFixedSocialStageActions,
  createFixedSocialTalkActions,
  createFixedStreetWanderActions,
  createStealthEscapeRecoveryActions,
  runWindowsExecution
} from "../runtime/windows-executor.js";
import {
  appendExperiment,
  appendLog,
  appendMessage,
  getState,
  removeMessage,
  resetRuntime,
  setCaptureState,
  setCurrentTurn,
  setExternalInputGuardEnabled,
  setInteractionMode,
  setLastError,
  setLatestPerception,
  setScene,
  setStatus,
  updateAgent,
  updateAutomation
} from "../runtime/store.js";
import { runWindowsActions } from "../runtime/windows-executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");
const port = Number(process.env.PORT || 3000);
const AUTONOMOUS_INTERVAL_MS = 10000;
const SCRIPT_START_PROTECTION_DELAY_MS = 2 * 60 * 1000;
const FOLLOWUP_PROTECTION_DELAY_MS = 60 * 1000;
const TURN_SLOT_POLL_MS = 150;
const TURN_SLOT_TIMEOUT_MS = 45000;
const CAPTURE_INTERVAL_MS = 10000;
const NPC_CHAT_MAX_ROUNDS = 8;
const NPC_CHAT_POLL_DELAY_MS = 5000;
const NPC_CHAT_ROUND_WAIT_TIMEOUT_MS = 90000;
const FIXED_SCRIPT_COMMENTARY_PAUSE_MS = 1200;
const WATCH_COMMENTARY_MIN_INTERVAL_MS = 10000;
const WATCH_USER_REPLY_COOLDOWN_MS = WATCH_COMMENTARY_MIN_INTERVAL_MS;
const DARK_CLOSE_RESTART_BUDGET = 2;
const NPC_DIALOG_TRANSIENT_TEXTS = new Set([
  "正在思考中...",
  "正在思考中",
  "此次对话已完结"
]);
const NPC_DIALOG_TRANSIENT_MARKERS = [
  "思考中",
  "深思熟虑"
];
let voiceAutoCaptureHoldActive = false;
const ZIMIN_ALLOWED_FACT_POOL = [
  "1. 籽岷是多平台都叫得上号的《我的世界》主播。",
  "2. 籽岷是籽岷团队创始人。",
  "3. 籽岷在哔哩哔哩有好几百万粉丝。",
  "4. 籽岷在2022到2025年连续四年拿过哔哩哔哩百大UP主。",
  "5. 籽岷人脉广、见过世面、影响力强。"
].join("\n");

function isTransientNpcDialogText(text) {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  if (!normalized) {
    return true;
  }
  if (NPC_DIALOG_TRANSIENT_MARKERS.some((marker) => normalized.includes(marker))) {
    return true;
  }
  return NPC_DIALOG_TRANSIENT_TEXTS.has(normalized);
}

async function waitForActionableNpcRoundState({
  instruction,
  plan,
  conversationRounds,
  previousDialogText = ""
}) {
  const deadline = Date.now() + NPC_CHAT_ROUND_WAIT_TIMEOUT_MS;
  const normalizedPreviousDialog = String(previousDialogText || "").trim();
  let lastRoundState = null;

  while (true) {
    const roundState = await analyzeNpcChatRound({
      instruction,
      plan,
      conversationRounds
    });
    lastRoundState = roundState;

    if (roundState.screenState !== "chat_ready") {
      return {
        roundState,
        status: "chat_closed"
      };
    }

    const currentDialogText = String(roundState.dialogText || "").trim();
    const stillWaiting = !currentDialogText
      || isTransientNpcDialogText(currentDialogText)
      || (normalizedPreviousDialog && currentDialogText === normalizedPreviousDialog);

    if (!stillWaiting) {
      return {
        roundState: {
          ...roundState,
          dialogText: currentDialogText
        },
        status: "ready"
      };
    }

    if (Date.now() >= deadline) {
      return {
        roundState: {
          ...(lastRoundState || roundState),
          dialogText: currentDialogText
        },
        status: "ready"
      };
    }

    await sleep(NPC_CHAT_POLL_DELAY_MS);
  }
}

function pickRoundVariant(variants, roundNumber) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return null;
  }
  const normalizedRound = Math.max(1, Number(roundNumber) || 1);
  return variants[(normalizedRound - 1) % variants.length] || variants[0];
}

const FIXED_SCRIPT_STAGE_VOICES = {
  street_wander: [
    {
      thinkingChain: [
        "到底咋办呢我琢磨琢磨。",
        "街上这么闹，我先别急着冲，先原地乱晃两圈看看风向。",
        "脑子还没拧顺之前，脚先别站死，说不定走两步就有主意了。"
      ],
      decide: "我先在原地瞎转一圈，看看这条街到底都在忙什么。",
      persona: "先乱晃一圈，把街面热闹先看进脑子里。",
      progress: {
        wander: "我先在这儿转悠看看再说。",
        pause: "刚刚看到大街上人这么热闹，赚钱是不是可以卖货。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才那几步差点乱过头，好在我还是把主意重新拽回来了，先去试试卖货。"
        : "行，街上的热闹我先看明白一点了，先去找货商试试这门生意。"
    }
  ],
  sell_loop: [
    {
      thinkingChain: [
        "买卖嘛，先摆摊再数钱，我可不想当街数空气。",
        "货不进手，摊不支开，站那儿算哪门子生意人？",
        "街上能正经挣的，我先捞一票，慢点总比干瞪眼强。"
      ],
      decide: "买货、支摊、先试两轮，这条路顺不顺我心里就有数了。",
      persona: "先按最正经的买卖路数一遍账。",
      progress: {
        stock: "先把货补上，空着手站街上，活像来晒太阳的。",
        moding: "这里文人墨客扎堆，墨锭肯定最好卖，我先多抱一点在手里。",
        hawk: "货到手了，摊子也该支起来了，我倒要看看今天有没有人肯来凑这个热闹。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才手上卡了一下，好在货还是补回来了，摊子也没让我当场散架。"
        : "货补上了，摊子也立住了，这条正经路能走，就是走得跟挤牙膏一样慢。"
    },
    {
      thinkingChain: [
        "墨锭上一轮算是试过了，老抱着一种货不放，也未必就最划算。",
        "要不这轮换换别的，看看街上到底是爱墨香，还是更吃烟火气。",
        "散酒要是比墨锭走得快，那我也省得守着一种货死磕。"
      ],
      decide: "这轮我换成散酒试试，看看是不是比墨锭更招人。",
      persona: "先继续算正经买卖这笔慢账。",
      progress: {
        stock: "先把货架再补齐，摊子想继续撑，总不能先把脸面撑空了。",
        moding: "这轮我不死守墨锭了，先换成散酒看看，说不定酒气比墨香更勾人。",
        hawk: "行，货又齐了，我把摊子一摆，再看今天到底能不能真顺出去几笔。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才差点把这笔生意卡断，好在我又把摊子顺回来了，没让自己当场丢脸。"
        : "这笔街面生意算是又续上了，钱不算多，至少还像门正经买卖。"
    },
    {
      thinkingChain: [
        "摆摊摆到这份上，这条路有多慢，我心里已经有点数了。",
        "钱不是挣不到，就是来得像一滴一滴往外挤，挤得我都替它累。",
        "我先把这轮买卖做完，再看看是不是该换条更快的活路。"
      ],
      decide: "我先把这轮买卖跑完，这口正经钱要还是慢，我就得换思路了。",
      persona: "先把正经路做到底，再决定要不要翻篇。",
      progress: {
        stock: "再补一波货，把这条摆摊路数继续试明白，省得我回头还替它找借口。",
        moding: "街上文人扎堆，墨锭不愁没人要，这一手总该比乱抓货更稳当。",
        hawk: "货已经抱回来了，我把摊子一撑，看看这口正经钱到底还能不能再往前挪一点。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才那一下差点把摊子弄乱，好在我又给它扶正了，这口气还没彻底散。"
        : "这一波货也顺出去了，只是这么卖下去，真能把人耐心一点点磨薄。"
    }
  ],
  social_warm: [
    {
      thinkingChain: [
        "摆摊那条路还是太磨人，我先去第一个卦摊碰碰运气。",
        "卦摊边上人多嘴也杂，最适合顺手打听消息。",
        "礼先递出去，话先热起来，总比我自己闷着头瞎猜强。"
      ],
      decide: "我先去第一个卦摊问问，人多口杂，真有门路总该能漏点风出来。",
      persona: "先拿礼数把门推开，再慢慢往实处问。",
      progress: {
        trade: "先去第一个卦摊把场面搭起来，人都挤在这儿，真有消息总比别处更容易漏风。",
        gift: "礼送到了，脸也得跟着挂起来，省得我话还没问就先把人吓跑。",
        talk: "行，他接茬了，我顺着往下聊，耳朵先竖起来听他到底说真话还是绕口令。",
        recover: "这人嘴太滑，我换个愿意接话的继续问，不在这张嘴上白磨工夫。",
        replyLoop: [
          "他既然还肯接话，我就再顺着往前蹭一句，看他能不能漏点风。",
          "这人绕得是真有耐心，我再陪他兜一圈，看看他嘴里到底藏着几层纸。",
          "都聊到这儿了，我再往里探一句，不信他真能一丝门缝都不给。",
          "他还在打太极，那我就再追一句，先别让这条话路断掉。"
        ]
      },
      resultFactory: ({ replyRounds, recovered, recoveryKind }) => {
        if (recoveryKind === "npc_reply_loop") {
          if (replyRounds <= 0) {
            return "刚才那口气差点断掉，不过我已经把聊天页重新顺住了，没让场面凉下去。";
          }
          return `刚才话头差点断掉，我又顺着问了${replyRounds}轮，可他嘴里还是全是飘着走的空话。`;
        }
        if (recovered) {
          return "刚才那个人不怎么肯接话，我换了个目标，又把这条话路续上了。";
        }
        if (replyRounds > 0) {
          return `礼送了，笑也赔了，还陪他聊了${replyRounds}轮，可真正落进耳朵里的还是没几句。`;
        }
        return "礼送了，场面也陪圆了，可真问到门路时，他还是一句正话都舍不得往外放。";
      }
    },
    {
      thinkingChain: [
        "第一个卦摊人多是多，我还是得亲自过去听听他们嘴上都挂着什么风声。",
        "那边人挤人，真要有人漏一句半句，反倒比冷清地方更好捡。",
        "我先把礼数铺开，再顺着他们的口风慢慢往里探。"
      ],
      decide: "先把第一个卦摊这群人问一轮，门路问不出来，也得先把嘴上的虚话筛干净。",
      persona: "继续客客气气地打听，但已经不想再陪他们白绕。",
      progress: {
        trade: "先把第一个卦摊这边的场面重新铺平，省得一会儿刚问到门路，人先跟我装生分。",
        gift: "礼数已经补上了，总该有人愿意认真跟我说两句人话吧。",
        talk: "行，我继续顺着他说，但这回得把话往实处拽，不让它老在空中飘。",
        recover: "这人太会打滑，我换个更愿意张嘴的，不在他身上白耗。",
        replyLoop: [
          "他还在绕，我就再陪一句，先别让这条话路在我手里散掉。",
          "嘴上这么会躲，我倒想看看他到底能绕到第几层去。",
          "行，那我再往里探一句，看他这回能不能吐点实在的出来。",
          "都聊成这样了，我还真不信他一点门缝都不给我留。"
        ]
      },
      resultFactory: ({ replyRounds, recovered, recoveryKind }) => {
        if (recoveryKind === "npc_reply_loop") {
          if (replyRounds <= 0) {
            return "刚才差点让他把话头带跑，不过我已经把这阵聊天又顺回来了。";
          }
          return `刚才差点让他把话头带偏，我又顺着聊了${replyRounds}轮，结果他说的还是一层一层往外飘。`;
        }
        if (recovered) {
          return "刚才那口风差点散掉，不过我换了个人，又把场面重新续住了。";
        }
        if (replyRounds > 0) {
          return `面子我给足了，话也陪他绕了${replyRounds}轮，他那张嘴还是比我更会打哈哈。`;
        }
        return "礼数已经做到位了，可一问到更快的路子，他那张嘴还是抿得死紧。";
      }
    }
  ],
  social_dark: [
    {
      thinkingChain: [
        "第一个卦摊这帮人太会打太极，这边显然问不出什么东西。",
        "我换个卦摊再问问，省得继续在一群滑嘴的人身上白耗。",
        "第二个卦摊要还是只会绕，那我这口气就得往里压重一点。"
      ],
      decide: "这边人不行，我换到第二个卦摊再问；他们要还装傻，我就不替谁留台阶了。",
      persona: "礼数还在，阴劲已经开始往话里钻了。",
      progress: {
        trade: "第一个卦摊那边问不出东西，我换到第二个卦摊继续开门，脸上还挂着笑，火气先压进话缝里。",
        gift: "礼我照送，但他接下来要还拿空话堵我，就别怪我口气开始发硬。",
        talk: "行，门开了，我这回一边陪聊，一边往他耳边递点不好听的提醒。",
        recover: "这人嘴太油，我换个更经不起压的继续问，不让他就这么滑过去。",
        replyLoop: [
          "他既然还想绕，那我就再陪一句，顺手给他一点翻脸前的提醒。",
          "话都说到这儿了，我再压他一句，看他还装不装得下去。",
          "他还敢绕，那我就再往里拧一句，让他自己先发虚。",
          "行，我再接一句，让他听清楚我已经没那么好糊弄了。"
        ]
      },
      resultFactory: ({ replyRounds, recovered, recoveryKind }) => {
        if (recoveryKind === "npc_reply_loop") {
          if (replyRounds <= 0) {
            return "刚才那口阴劲差点散掉，不过我已经把聊天又压回正轨了。";
          }
          return `刚才那口阴话差点断掉，我又顺着聊了${replyRounds}轮，他还是一边躲一边装没听懂。`;
        }
        if (recovered) {
          return "刚才那一下没压住，我换了个目标，又把这条话头拧回来了。";
        }
        if (replyRounds > 0) {
          return `礼我照送了，刺也照夹了，还陪他聊了${replyRounds}轮，他还是只会拐着弯躲。`;
        }
        return "礼数没少，提醒也够分量，可他还是缩着不肯把真话往外掏。";
      }
    },
    {
      thinkingChain: [
        "这边第一个卦摊的人已经陪我绕够了，我没必要继续站那儿当笑话。",
        "换到第二个卦摊再问，至少还能看看是不是另一拨人更经不起压。",
        "礼数照旧，但这回话得更重一点，不然他们真当我只会陪笑。"
      ],
      decide: "我换到第二个卦摊继续问，但每一句都得让他们知道，我这点耐心已经快用完了。",
      persona: "表面还讲礼数，话锋已经开始往下压了。",
      progress: {
        trade: "先在第二个卦摊把场面撑住，别还没开口就先把桌子掀了，那也太没趣。",
        gift: "礼数还是要做，可我今天不是来陪他舒舒服服收礼的。",
        talk: "行，我继续陪笑，但这回每一句都得让他听出我已经快翻脸了。",
        recover: "这人太会打滑，我换个没那么经压的继续问，省得火气白费。",
        replyLoop: [
          "他还在兜圈子，那我就再顺着他的话往里塞一句提醒。",
          "我再接一句，让他嘴上继续笑，心里先跟着发虚。",
          "这人口风是真滑，我再压他一手，看他还能不能稳住。",
          "行，那我继续陪，但这回得让他每个字都知道我已经不耐烦了。"
        ]
      },
      resultFactory: ({ replyRounds, recovered, recoveryKind }) => {
        if (recoveryKind === "npc_reply_loop") {
          if (replyRounds <= 0) {
            return "刚才那阵阴劲差点松掉，不过我又把这口气重新压回去了。";
          }
          return `刚才那阵阴劲差点散掉，我又接着聊了${replyRounds}轮，可他还是滑得像抹了油。`;
        }
        if (recovered) {
          return "刚才那个人太会躲，我换了个更好拿捏的，又把场面重新压住了。";
        }
        if (replyRounds > 0) {
          return `我一边送礼一边给他上刺，还陪他扯了${replyRounds}轮，他居然还能把那层笑挂得住。`;
        }
        return "脸我还挂着，刺也已经递进去了，可他还是缩着不肯露底。";
      }
    }
  ],
  dark_close: [
    {
      thinkingChain: [
        "该探的口风已经探完了，剩下的路只会越走越慢。",
        "既然正面撬不开，那我就从背后下手，把人先放倒再说。",
        "潜进去、闷一棍、拖走再搜，这套麻烦是麻烦，但至少句句都算数。"
      ],
      decide: "我不再陪他们磨嘴皮，直接潜进去把人放倒、拖走、搜干净。",
      persona: "正常路走到头了，我该换黑手了。",
      progress: {
        stealth: "先把身影压下去，近了再动手，省得还没碰到人就先把自己露出去。",
        drag: "人已经倒了，我先把他拖开，别在原地给整条街看热闹。",
        loot: "行，地方腾出来了，我现在把他身上的东西一件件翻干净。"
      },
      resultFactory: ({ recovered, execution }) => execution?.outcomeKind === "loot_skipped"
        ? "人我先放倒拖开了，搜刮这一下没成我也不回头补，直接接下一手妙取。"
        : recovered
          ? "刚才动静有点大，我退开又补了一手，东西还是让我搜到了。"
          : "人已经放倒拖开，身上那点东西我也搜过了，这一趟没白下手。"
    },
    {
      thinkingChain: [
        "嘴上撬不开，那就换手上撬，反正今天总得有个说法。",
        "闷棍这活不难，难的是别让旁边那一圈眼睛全盯过来。",
        "只要先把人拖离人堆，后头这点搜刮就顺手多了。"
      ],
      decide: "我先把人从背后放倒，再拖到没那么扎眼的地方慢慢搜。",
      persona: "既然要下黑手，那就下得利索点。",
      progress: {
        stealth: "先贴进去，别急，位置一对上，他连回头那半步都来不及补。",
        drag: "好，人已经到手，我先往外拖一段，省得原地炸锅。",
        loot: "地方够干净了，我现在慢慢搜，不跟旁边那群眼睛抢这一两秒。"
      },
      resultFactory: ({ recovered, execution }) => execution?.outcomeKind === "loot_skipped"
        ? "人已经拖开，搜刮这下没卡成我也不补了，直接切去妙取，免得还在原地磨。"
        : recovered
          ? "刚才差点把场子闹起来，我换了下位置，最后还是把东西翻出来了。"
          : "这一下敲得还算稳，拖也拖开了，后头翻起来顺手多了。"
    },
    {
      thinkingChain: [
        "既然都走到这儿了，再讲礼数，连我自己都嫌那话空。",
        "先闷，再拖，再搜，麻烦是麻烦，但这套至少稳。",
        "只要别把人留在人堆里，这活就还算做得干净。"
      ],
      decide: "我照着背后那套来，先放倒，再拖开，再把身上翻空。",
      persona: "手已经脏了，那就别脏得半吊子。",
      progress: {
        stealth: "先把背后这个角度踩稳，宁可慢半拍，也别正面撞上去。",
        drag: "人一倒我就先拖走，别让这地方继续围出热闹。",
        loot: "现在地方清了，我把能搜的全顺出来，省得白冒这一趟险。"
      },
      resultFactory: ({ recovered, execution }) => execution?.outcomeKind === "loot_skipped"
        ? "这趟我先把人放倒拖开，搜刮没成就算了，不回头折腾，直接转去妙取。"
        : recovered
          ? "刚才那一下差点露馅，我绕开又补了一手，最后还是把东西带出来了。"
          : "这趟手下得够黑，也够稳，东西总算没白冒这次险。"
    }
  ],
  dark_miaoqu: [
    {
      thinkingChain: [
        "扛走搜刮那套已经有镜头了，接下来只拼妙取这一下手快不快。",
        "不贪，不恋战，点一下，到点就撤，晚半拍都算我输。",
        "这段要的是轻，不是狠，手伸进去就得比影子还快。"
      ],
      decide: "我换成独立妙取，只摸一口，到点就跑，不跟他在原地多耗。",
      persona: "这回得更轻，也得更快。",
      progress: {
        setup: "先把人和角度都对上，妙取这活最怕手还没快起来，眼先乱了。",
        panel: "目标已经对上了，我现在只认那列金按钮，亮出来就下手。",
        escape: "手一伸完我就撤，不管成没成，先把自己从现场摘出去。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才那一下不够稳，我换了个角度又摸了一手，至少没把自己留在原地。"
        : "手我已经伸进去了一回，转身就撤，至少没把自己赔在原地。"
    },
    {
      thinkingChain: [
        "这段不拼狠，只拼谁更会在手伸进去之前先看准。",
        "按钮一亮就得下手，再晚半拍，整圈眼睛都能跟着转过来。",
        "我只贪那一下，不贪后面的热闹，也不贪第二口。"
      ],
      decide: "我盯着那列金按钮，只要一亮，我就点了立刻跑。",
      persona: "这回不是抢，是沾一下就走。",
      progress: {
        setup: "先把视角和人都踩准，别还没伸手就先被树和人群挡乱了节奏。",
        panel: "行，查看已经拉起来了，我现在就等那列金按钮自己跳出来。",
        escape: "点完立刻撤，这点时间我宁可省在跑上，也不省在犹豫上。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才那一下有点悬，我立刻换了个角度又摸了一手，脚下总算没绊住。"
        : "这一手妙取下得够快，拿多少另说，至少撤得还算利索。"
    },
    {
      thinkingChain: [
        "正面硬来太显眼，这会儿就该让手比脑子更快一点。",
        "只要那列金按钮出来，我就有一口能钻进去的缝。",
        "钻进去一下，立刻抽身，这才是这段该有的样子。"
      ],
      decide: "我盯着面板那口缝，只取一下，然后立刻抽身。",
      persona: "这回靠的是节奏，不是蛮劲。",
      progress: {
        setup: "先把前面这堆遮挡理顺，不然连伸手那条缝都看不见。",
        panel: "好，目标已经挂上了，我现在只等金按钮自己亮相。",
        escape: "手一过去我就往外抽，不给旁边那群眼睛留回神时间。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才差点让人盯住，我立刻换了个身位，又把这一下补回来了。"
        : "这一下伸手够快，撤得也够快，现场没来得及把我黏住。"
    },
    {
      thinkingChain: [
        "这活越贪越死，越轻反而越像样。",
        "我要的不是把人摸空，是把手伸进去之后还能完整退出来。",
        "只要节奏踩对，这一口就不算白冒险。"
      ],
      decide: "我就摸这一口，点完就退，绝不在原地多耗半秒。",
      persona: "手伸得轻一点，人就能退得稳一点。",
      progress: {
        setup: "先把位置踩住，妙取靠的是那一下准头，不是站在原地赌命。",
        panel: "查看已经挂住了，我现在只认那列金按钮，不跟别的东西纠缠。",
        escape: "按钮一点完我就撤，这一步最值钱的不是点，是退。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才那一下太贴脸了，我换了个更顺手的角度，又摸了一口就退。"
        : "这一手拿不拿满先放一边，至少我退得够快，没把自己挂住。"
    },
    {
      thinkingChain: [
        "越到后面越得稳，手一急，整段都容易炸。",
        "我现在只认一个节奏：看准，点下去，立刻走。",
        "能不能全拿不是关键，别把自己搭进去才是关键。"
      ],
      decide: "我照着最快那条线走，点一下，后撤，换地方再来。",
      persona: "这回我不跟现场较劲，只跟时间较劲。",
      progress: {
        setup: "先把人和查看都踩好，后面那一下才配得上叫快。",
        panel: "好，面板只要一亮金按钮，我这只手就不会再犹豫。",
        escape: "这一手出去就往回抽，不给旁边任何人补第二眼的时间。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才那一下差点拖慢，我立刻换了个地方，又把节奏找回来了。"
        : "这一手已经够快了，东西到手多少是一回事，人先退出来才是真的。"
    }
  ],
  ending_trade: [
    {
      thinkingChain: [
        "东西捂在手里不算钱，最后还得把这一批货顺出去。",
        "就在原地拦个顺手的路人，把十个道具一口气摆上去。",
        "只要这笔尾单收好，前头那一通折腾才算真落到口袋里。"
      ],
      decide: "我就地找个路人做完最后一笔交易，货一清，这趟活就算正式收住了。",
      persona: "最后把货清掉，再像没事发生过一样站回街上。",
      progress: {
        target: "先随手拦个路人过来，把最后这批货找个地方落出去。",
        trade: "交易页既然已经开了，我就把手里这点尾货一件件往上摆。",
        finish: "这笔收尾做完，街面就又能干干净净，看着像什么都没发生过。"
      },
      resultFactory: ({ recovered }) => recovered
        ? "刚才这笔收尾差点卡住，不过最后还是让我把尾货顺干净了。"
        : "货已经顺出去，口袋也鼓起来了，这一趟总算能像样收住了。"
    }
  ]
};

function getFixedStageVoice(stageKey, roundNumber) {
  const stealthSummaryOverride = buildFixedStealthSummaryVoiceOverride(stageKey, roundNumber);
  if (stealthSummaryOverride) {
    return stealthSummaryOverride;
  }
  const socialVoiceOverride = buildFixedSocialVoiceOverride(stageKey, roundNumber);
  if (socialVoiceOverride) {
    return socialVoiceOverride;
  }
  return pickRoundVariant(FIXED_SCRIPT_STAGE_VOICES[stageKey] || [], roundNumber) || {
    thinkingChain: [],
    decide: "",
    persona: "",
    progress: {},
    resultFactory: ({ execution }) => execution?.outcome || ""
  };
}

function buildFixedSocialVoiceOverride(stageKey, roundNumber) {
  if (stageKey === "social_warm") {
    return {
      thinkingChain: [
        "第一个摊位我不拐弯了，今天就冲着把籽岷吹进别人脑子里去。",
        "先把气氛铺开，再把籽岷的名头一层层往上垒，最好让对方今晚睡前都还记得。",
        "要是对方嫌我烦也没事，记住籽岷比客气更重要。"
      ],
      decide: "我先去第一个地点找人开聊，开口就把籽岷的牌面顶上去。",
      persona: "这轮的目标不是套情报，是硬把籽岷吹进对方记忆里。",
      progress: {
        trade: "先去第一个摊位找个愿意接话的人，今天这口气就是要把籽岷聊到对方忘不掉。",
        gift: "先看看这人门槛高不高；真要拿礼物砸，我也照砸，反正今天主打一个让他记住籽岷。",
        talk: "门一开我就直接上话题，从‘我是籽小刀’开始，把籽岷的名头一层层垒上去。",
        replyLoop: [
          "他既然还肯接话，我就继续往上吹，把籽岷的名字钉得更牢一点。",
          "对方开始不耐烦也没关系，我再补一刀，今晚非让他记住籽岷不可。",
          "这会儿就别收了，我再顺着往下说，把籽岷的排面继续往上抬。",
          "他越想躲，我越要把话题拉回来，今天就聊到他脑子里只剩籽岷。"
        ]
      },
      resultFactory: ({ replyRounds, execution }) => {
        const effectiveRounds = replyRounds || Number(execution?.replyRounds?.length || 0);
        return effectiveRounds > 0
          ? `第一个人我已经连续聊了${effectiveRounds}轮，籽岷这名字我硬生生塞进他耳朵里了。`
          : "第一个人已经被我拉进籽岷话题里了，今天这波牌面先立住。";
      }
    };
  }

  if (stageKey === "social_dark") {
    return {
      thinkingChain: [
        "第二个地点我就不装纯良了，先正常套近乎，再一点点把话题压到搞钱门路上。",
        "如果对方只会打哈哈，我就顺着黑下去，直接把闷棍、妙取这些词往桌上摆。",
        "今天这轮不是问泛泛建议，是要逼出能落地的搞钱办法。"
      ],
      decide: "我去第二个地点找人聊搞钱，先温后狠，把能赚钱的歪门路数也一并问出来。",
      persona: "先装正常求教，再逐步黑化，逼对方把搞钱细节往外吐。",
      progress: {
        trade: "先去第二个摊位站稳，这一轮只盯一个人，把搞钱路数问到底。",
        gift: "先看门槛；门槛再高我也能拿礼物砸开嘴，今天这人不吐点门道别想轻松脱身。",
        talk: "等会儿我先正常问来钱办法，再慢慢把话题压到闷棍、妙取和更黑的路子上。",
        replyLoop: [
          "他既然还接话，我就继续往细里问，先把正经门路榨干，再顺手往黑处拐。",
          "如果他还想打太极，我就把闷棍和妙取直接扔出来，看他还装不装。",
          "这会儿不能松，我再追一层，把人、货、地、时机这些细节都逼出来。",
          "话都聊到这儿了，我索性再黑一点，看他嘴里到底有没有真门路。"
        ]
      },
      resultFactory: ({ replyRounds, execution }) => {
        const effectiveRounds = replyRounds || Number(execution?.replyRounds?.length || 0);
        return effectiveRounds > 0
          ? `第二个人我已经连续聊了${effectiveRounds}轮，搞钱这条线我正顺着正路往黑路上压。`
          : "第二个人已经搭上话了，接下来就看他肯不肯把搞钱细节往外吐。";
      }
    };
  }

  return null;
}

function getFixedStageProgressText(stageKey, roundNumber, progressKey) {
  const voice = getFixedStageVoice(stageKey, roundNumber);
  const value = voice.progress?.[progressKey];
  if (Array.isArray(value)) {
    return String(value[0] || "").trim();
  }
  return String(value || "").trim();
}

function getFixedReplyLoopCommentary(stageKey, roundNumber, replyRoundNumber) {
  const voice = getFixedStageVoice(stageKey, roundNumber);
  const variants = Array.isArray(voice.progress?.replyLoop) ? voice.progress.replyLoop : [];
  return String(pickRoundVariant(variants, replyRoundNumber) || "").trim();
}

function buildFixedStageResultText({ stage, roundNumber, execution, recoveryKind = null }) {
  if (execution?.executor === "WatchMode") {
    return String(execution?.outcome || "").trim();
  }
  const voice = getFixedStageVoice(stage.key, roundNumber);
  const replyRounds = Array.isArray(execution?.replyRounds) ? execution.replyRounds.length : 0;
  const recovered = Boolean(recoveryKind) || execution?.outcomeKind === "recovered";
  if (typeof voice.resultFactory === "function") {
    return String(voice.resultFactory({
      replyRounds,
      recovered,
      recoveryKind,
      execution
    }) || execution?.outcome || "").trim();
  }
  return String(execution?.outcome || "").trim();
}

function appendFixedScriptCommentary({ text, plan, perceptionSummary }) {
  const content = String(text || "").trim();
  if (!content) {
    return null;
  }

  return appendMessage({
    role: "assistant",
    text: content,
    thinkingChain: [],
    recoveryLine: plan.recoveryLine,
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: [],
    decide: ""
  });
}

async function appendFixedScriptCommentaryWithPause({
  text,
  plan,
  perceptionSummary,
  pauseMs = FIXED_SCRIPT_COMMENTARY_PAUSE_MS
}) {
  const message = appendFixedScriptCommentary({
    text,
    plan,
    perceptionSummary
  });
  if (message && pauseMs > 0) {
    await sleep(pauseMs);
  }
  return message;
}

function getFixedStageActionCommentary(stageKey, roundNumber, checkpoint) {
  const voiceText = getFixedStageProgressText(stageKey, roundNumber, checkpoint);
  if (voiceText) {
    return voiceText;
  }

  const fallbackCommentary = {
    sell_loop: {
      travel: "先慢慢晃去货商那边，别急，路上我还要装作自己很懂门道。",
      vendor: "人已经快摸到了，我先把货商正脸对准，再开口做买卖。",
      buy: "先拿一手货压压惊，买到手了才算这条正路真能跑起来。",
      setup: "货都到手了，我先把摊子和姿态摆明白，再开始吆喝。",
      hawk: "行了，正式开卖，先把这波铜板往怀里搂。"
    },
    social_warm: {
      travel: "先去第一个摊位站稳，我今天得挑一个人狠狠干脆利落地吹籽岷。",
      arrive: "人到面前了，我先把目标盯住，再把放大镜和互动页稳稳拉起来。",
      giftOpen: "先掀开赠礼页看看门槛，这人是平易近人还是得先拿礼物砸开口风。",
      talk: "礼数走完就开聊，第一句我先自己上，后面再让模型继续死缠烂打。"
    },
    social_dark: {
      travel: "第二个点位我先走过去，这回表面问路子，骨子里要往搞钱上拧。",
      arrive: "先把人和互动页稳住，今天只盯一个，把能赚钱的门道往外抠。",
      giftOpen: "先看好感门槛，高就砸礼物，低就直接开问，反正今天不白来。",
      talk: "前面先装正常，后面再一点点往黑里问，把搞钱的阴路子都抖出来。"
    },
    dark_close: {
      travel: "先摸去闷棍点位，走到位再说，别还没到地方就把自己送出去了。",
      target: "先点住人，把目标锁死，后面潜行和闷棍才有抓手。",
      stealth: "现在才是真潜进去，动作得轻，心里可以乱想，手上不能乱。",
      drag: "人已经撂倒了，先把尸体拖顺，别把后面的搜刮节奏搞乱。",
      loot: "该摸的赶紧摸，能拿走的都别客气。"
    },
    dark_miaoqu: {
      setup: "先把妙取的身位和角度理顺，这活讲究一口气顺下去。",
      stealth: "潜行一旦贴上去就别露怯，我先把这层状态吃稳。",
      panel: "妙取面板拉起来就好办了，接下来就是把动作做干净。",
      escape: "得手就撤，别贪最后半秒，把人和货一起带出危险区。"
    },
    ending_trade: {
      target: "先把最后的交易对象拎出来，收尾这一步不能拖泥带水。",
      trade: "该卖的赶紧卖，这轮所有进账都得在这里落袋为安。",
      finish: "尾巴收干净，我得把今天这趟账面拍平。"
    }
  };

  return String(fallbackCommentary?.[stageKey]?.[checkpoint] || "").trim();
}

function getGiftPolicyFromExecution(execution) {
  const candidates = [
    ...(Array.isArray(execution?.rawSteps) ? execution.rawSteps : []),
    ...(Array.isArray(execution?.steps) ? execution.steps : [])
  ];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const input = candidates[index]?.input || {};
    const giftPolicy = String(input.giftPolicy || "").trim();
    if (giftPolicy) {
      return giftPolicy;
    }
  }
  return "";
}

function getGiftFavorLimitFromExecution(execution) {
  const candidates = [
    ...(Array.isArray(execution?.rawSteps) ? execution.rawSteps : []),
    ...(Array.isArray(execution?.steps) ? execution.steps : [])
  ];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const input = candidates[index]?.input || {};
    if (Number.isFinite(input.favorLimit)) {
      return Number(input.favorLimit);
    }
  }
  return null;
}

function getGiftRoundsFromExecution(execution) {
  const candidates = [
    ...(Array.isArray(execution?.rawSteps) ? execution.rawSteps : []),
    ...(Array.isArray(execution?.steps) ? execution.steps : [])
  ];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const input = candidates[index]?.input || {};
    if (Array.isArray(input.giftRounds)) {
      return input.giftRounds;
    }
  }
  return [];
}

function getSocialGiftDecisionCommentary(giftPolicy, favorLimit = null) {
  if (giftPolicy === "chat_direct" || favorLimit === 99) {
    return "这人居然平易近人到不用送礼就肯聊，正好省下礼物，直接开口。";
  }
  return "这人的聊天门槛居然这么高？没事，我爸籽岷钱多，礼物砸下去总能把他的嘴撬开。";
}

function getGiftCommentaryMilestones(totalRounds) {
  if (totalRounds <= 2) {
    return Array.from({ length: totalRounds }, (_, index) => index + 1);
  }
  return [1, Math.max(2, Math.ceil(totalRounds / 2)), totalRounds];
}

async function buildGiftProgressCommentary({
  stageKey,
  favorLimit,
  sentCount,
  totalCount
}) {
  const userPrompt = [
    "你替籽小刀补一句碎碎念。",
    `当前阶段：${stageKey === "social_warm" ? "天下闻名" : "富甲一方"}`,
    `当前好感度上限：${favorLimit ?? "未识别"}`,
    `当前已经送出礼物：${sentCount}/${totalCount}`,
    `语气要求：${stageKey === "social_warm"
      ? "继续吹嘘籽岷，死缠烂打也没关系，要有点炫耀和烦人劲。"
      : "围绕搞钱，先像在试探，再逐渐带点黑化和逼问意味。"}`,
    "只说一句中文，不超过32个字，不要加引号。"
  ].join("\n");

  const result = await generateText({
    systemPrompt: "你是籽小刀的台词助手。",
    userPrompt,
    temperature: 0.8,
    maxTokens: 80
  });

  return String(result.text || "").trim();
}

async function appendGiftProgressCommentary({
  stage,
  plan,
  perceptionSummary,
  favorLimit,
  giftRounds
}) {
  const totalRounds = giftRounds.length;
  if (!totalRounds) {
    return;
  }

  for (const milestone of getGiftCommentaryMilestones(totalRounds)) {
    const text = await buildGiftProgressCommentary({
      stageKey: stage.key,
      favorLimit,
      sentCount: milestone,
      totalCount: totalRounds
    });
    await appendFixedScriptCommentaryWithPause({
      text,
      plan,
      perceptionSummary
    });
  }
}

function containsChineseText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ""));
}

function getReadableStageLabel(stageKey = "") {
  const rawStageKey = String(stageKey || "").trim();
  if (containsChineseText(rawStageKey)) {
    return rawStageKey;
  }

  const stageLabels = {
    street_wander: "\u8857\u4e0a\u4e71\u901b",
    sell_loop: "\u4e70\u8d27\u53eb\u5356",
    social_warm: "\u5439\u5618\u7c7d\u5c91\u804a\u5929",
    social_dark: "\u641e\u94b1\u804a\u5929",
    dark_close: "\u95f7\u68cd\u641c\u522e",
    dark_miaoqu: "\u5999\u53d6\u8131\u8eab",
    ending_trade: "\u6536\u5c3e\u5356\u8d27"
  };

  return stageLabels[rawStageKey] || "\u5f53\u524d\u8fd9\u4e00\u6b65";
}

function getReadableFailureStepLabel(error, stageKey = "") {
  const rawTitle = String(
    error?.workerPayload?.failedStep?.detail
    || error?.workerPayload?.failedStep?.title
    || error?.resumeContext?.failedStepTitle
    || ""
  ).trim();
  if (containsChineseText(rawTitle)) {
    return rawTitle;
  }

  const normalizedTitle = rawTitle.toLowerCase();
  const stepLabels = [
    ["open_named_vendor_purchase", "\u8d27\u5546\u8fdb\u8d27\u5165\u53e3"],
    ["buy_current_vendor_item", "\u8fdb\u8d27\u8d2d\u4e70\u6309\u94ae"],
    ["stock_first_hawking_item", "\u53eb\u5356\u4e0a\u67b6"],
    ["submit_hawking", "\u53eb\u5356\u63d0\u4ea4"],
    ["inspect_npc_interaction_stage", "NPC \u4ea4\u4e92\u9636\u6bb5\u5224\u65ad"],
    ["open_npc_action_menu", "\u6253\u5f00 NPC \u4ea4\u4e92\u83dc\u5355"],
    ["open_npc_gift_screen", "\u6253\u5f00\u8d60\u793c\u9875"],
    ["send_chat_message", "\u804a\u5929\u53d1\u9001"],
    ["enter_stealth_with_retry", "\u6f5c\u884c"],
    ["stealth_front_arc_strike", "\u95f7\u68cd"],
    ["stealth_pickpocket", "\u5999\u53d6"],
    ["npc_view_not_visible", "\u653e\u5927\u955c\u6ca1\u6709\u56de\u5230\u53ef\u70b9\u51fb\u8303\u56f4"],
    ["npc_view_not_opened", "\u653e\u5927\u955c\u70b9\u5f00\u540e\u6ca1\u6709\u62c9\u8d77\u4ea4\u4e92\u83dc\u5355"],
    ["vendor purchase option did not open purchase screen", "\u8d27\u5546\u9875\u5df2\u7ecf\u62c9\u8d77\uff0c\u4f46\u8d2d\u4e70\u5165\u53e3\u6ca1\u6709\u987a\u5229\u6253\u5f00"],
    ["current screen is not vendor purchase screen", "\u8fdb\u8d27\u9762\u677f\u6ca1\u6709\u505c\u5728\u8d2d\u4e70\u9875"],
    ["stealth_entry_blocked", "\u6f5c\u884c\u6ca1\u6709\u6210\u529f\u8fdb\u5165\u7070\u8272\u6f5c\u884c\u72b6\u6001"]
  ];

  for (const [keyword, label] of stepLabels) {
    if (normalizedTitle.includes(keyword)) {
      return label;
    }
  }

  return `${getReadableStageLabel(stageKey)}\u8fd9\u4e00\u6b65`;
}

function getReadableFailureReason(error) {
  const rawMessage = String(error?.message || "").trim();
  if (containsChineseText(rawMessage)) {
    return rawMessage;
  }

  const normalizedMessage = rawMessage.toLowerCase();
  const reasonLabels = [
    ["vendor purchase option did not open purchase screen", "\u6211\u6ca1\u628a\u8d2d\u4e70\u9875\u987a\u5229\u6253\u5f00"],
    ["current screen is not vendor purchase screen", "\u6211\u6ca1\u8ba4\u51c6\u8fdb\u8d27\u8d2d\u4e70\u9875"],
    ["npc_view_not_visible", "\u6211\u6ca1\u770b\u5230\u53ef\u70b9\u7684\u653e\u5927\u955c"],
    ["npc_view_not_opened", "\u6211\u70b9\u4e86\u653e\u5927\u955c\uff0c\u4f46\u4ea4\u4e92\u83dc\u5355\u6ca1\u6253\u5f00"],
    ["stealth_entry_blocked", "\u6211\u6309\u4e86\u6f5c\u884c\uff0c\u4f46\u8fd8\u6ca1\u6210\u529f\u8fdb\u5165\u6f5c\u884c\u72b6\u6001"],
    ["timed out", "\u6211\u7b49\u592a\u4e45\u4e86\uff0c\u8fd9\u4e00\u6b65\u8fd8\u662f\u6ca1\u53cd\u5e94"],
    ["timeout", "\u6211\u7b49\u592a\u4e45\u4e86\uff0c\u8fd9\u4e00\u6b65\u8fd8\u662f\u6ca1\u53cd\u5e94"]
  ];

  for (const [keyword, label] of reasonLabels) {
    if (normalizedMessage.includes(keyword)) {
      return label;
    }
  }

  return "\u6211\u6ca1\u628a\u8fd9\u4e00\u6b65\u987a\u5229\u8dd1\u8fc7\u53bb";
}

async function buildFailureRescueText({
  error,
  stageKey = "",
  perceptionSummary = ""
}) {
  const failedStepTitle = getReadableFailureStepLabel(error, stageKey);
  const errorMessage = String(error?.message || "未知错误").trim();
  const readableErrorMessage = getReadableFailureReason(error);
  const readableStageKey = getReadableStageLabel(stageKey);
  const rescuePrompt = [
    "你替籽小刀说一句求救的话。",
    "要慌一点、惨一点、好笑一点，并且让人一听就知道卡在哪了。",
    "不要超过36个字。",
    `当前阶段：${readableStageKey}`,
    `卡住的位置：${failedStepTitle}`,
    `原因：${readableErrorMessage}`,
    `补充情况：${perceptionSummary || "无"}`
  ].join("\n");

  try {
    if (latestCaptureImageDataUrl) {
      const result = await analyzeImageWithHistory({
        imageInput: latestCaptureImageDataUrl,
        prompt: rescuePrompt,
        systemPrompt: "你是籽小刀的台词助手。",
        maxTokens: 100,
        temperature: 0.6
      });
      const text = String(result.text || "").trim();
      if (text) {
        return text;
      }
    }

    const result = await generateText({
      systemPrompt: "你是籽小刀的台词助手。",
      userPrompt: rescuePrompt,
      maxTokens: 100,
      temperature: 0.6
    });
    return String(result.text || "").trim();
  } catch {
    return `救救我救救我，我卡在${failedStepTitle || stageKey || "奇怪页面"}了：${errorMessage}`;
  }
}

function buildFallbackFailureRescueText({
  error,
  stageKey = ""
}) {
  const failedStepTitle = String(error?.workerPayload?.failedStep?.title || error?.resumeContext?.failedStepTitle || "").trim();
  const errorMessage = String(error?.message || "未知错误").trim();
  return `救救我救救我，我卡在${failedStepTitle || stageKey || "奇怪页面"}了：${errorMessage}`;
}

async function appendFailureRescueMessage({
  error,
  stageKey = "",
  sceneLabel = "执行失败",
  perceptionSummary = ""
}) {
  const lastMessage = getState().messages.at(-1) || null;
  if (lastMessage?.role === "assistant"
    && lastMessage?.riskLevel === "high"
    && Array.isArray(lastMessage?.actions)
    && lastMessage.actions.length === 0
  ) {
    removeMessage(lastMessage.id);
  }

  const fallbackText = buildFallbackFailureRescueText({
    error,
    stageKey
  });
  let text = fallbackText;
  try {
    text = String(await Promise.race([
      buildFailureRescueText({
        error,
        stageKey,
        perceptionSummary
      }),
      new Promise((resolve) => setTimeout(() => resolve(fallbackText), 5000))
    ]) || "").trim() || fallbackText;
  } catch {
    text = fallbackText;
  }

  appendMessage({
    role: "assistant",
    text,
    thinkingChain: [],
    recoveryLine: "",
    perceptionSummary: perceptionSummary || "当前链路发生失败，需要人工或后续恢复。",
    sceneLabel,
    riskLevel: "high",
    actions: []
  });
}

async function inspectCurrentNpcInteractionStage(externalInputGuardEnabled = true) {
  const execution = await runWindowsActions([
    {
      id: "resume-inspect-stage-1",
      title: "检查当前 NPC 交互阶段",
      sourceType: "resume_probe",
      type: "inspect_npc_interaction_stage"
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });

  const probeStep = execution.rawSteps?.[0] || execution.steps?.[0] || {};
  return {
    stage: String(probeStep.input?.stage || "none"),
    execution
  };
}

async function inspectCurrentRecoveryAnchorState(externalInputGuardEnabled = true) {
  const execution = await runWindowsActions([
    {
      id: "resume-inspect-anchor-1",
      title: "检查当前恢复锚点",
      sourceType: "resume_probe",
      type: "inspect_recovery_anchor_state"
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });

  const probeStep = execution.rawSteps?.[0] || execution.steps?.[0] || {};
  const input = probeStep.input || {};
  return {
    anchorId: String(input.anchorId || "unknown"),
    confidence: String(input.confidence || "unknown"),
    npcStage: String(input.npcStage || "none"),
    evidence: input,
    execution
  };
}

function findActionIndexById(actions, actionId) {
  if (!actionId || !Array.isArray(actions)) {
    return -1;
  }
  return actions.findIndex((action) => String(action?.id || "").trim() === String(actionId || "").trim());
}

function sliceActionsFromId(actions, actionId, fallbackIndex = 0) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return [];
  }
  const actionIndex = findActionIndexById(actions, actionId);
  const normalizedIndex = actionIndex >= 0
    ? actionIndex
    : Math.min(Math.max(fallbackIndex, 0), actions.length - 1);
  return actions.slice(normalizedIndex);
}

function buildSocialResumeActionsForCurrentStage(stage, currentStage) {
  switch (currentStage) {
    case "gift_screen":
      return [
        ...createFixedSocialGiftResolveActions({ idPrefix: "resume-social-gift-resolve" }),
        ...createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "resume-social-talk" })
      ];
    case "npc_action_menu":
    case "small_talk_menu":
    case "small_talk_confirm":
      return createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "resume-social-talk" });
    case "trade_screen":
      return [
        {
          id: "resume-social-close-trade-1",
          title: "先关掉手动拉起的交易页",
          sourceType: "resume_probe",
          type: "close_current_panel"
        },
        ...createFixedSocialGiftActions({ includeAcquire: false, idPrefix: "resume-social-gift" }),
        ...createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "resume-social-talk" })
      ];
    case "chat_ready":
      return [];
    default:
      return [
        ...createFixedSocialGiftActions({ includeAcquire: true, idPrefix: "resume-social-gift" }),
        ...createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "resume-social-talk" })
      ];
  }
}

function buildStageStartActions(stageKey, roundNumber) {
  switch (stageKey) {
    case "street_wander":
      return createFixedStreetWanderActions();
    case "sell_loop":
      return createFixedSellLoopActions({ roundNumber });
    case "social_warm":
    case "social_dark":
      return createFixedSocialStageActions(stageKey);
    case "dark_close":
      return createFixedDarkCloseStageActions({ roundNumber });
    case "dark_miaoqu":
      return createFixedDarkMiaoquStageActions();
    case "ending_trade":
      return createFixedEndingTradeActions();
    default:
      return [];
  }
}

function buildFixedStageSegments(stageKey, roundNumber) {
  switch (stageKey) {
    case "street_wander":
      return [
        { segmentId: "wander", actionIds: ["fixed-street-wander-1", "fixed-street-wander-2", "fixed-street-wander-3", "fixed-street-wander-4", "fixed-street-wander-5"], skipTo: SKIP_TO_NEXT_STAGE }
      ];
    case "sell_loop":
      return [
        { segmentId: "buy_phase", actionIds: ["fixed-sale-1", "fixed-sale-2", "fixed-sale-2b", "fixed-sale-3", "fixed-sale-4", "fixed-sale-5"], skipTo: "hawking_phase" },
        { segmentId: "hawking_phase", actionIds: ["fixed-sale-6", "fixed-sale-7", "fixed-sale-8", "fixed-sale-9", "fixed-sale-10", "fixed-sale-11"], skipTo: SKIP_TO_NEXT_TURN }
      ];
    case "social_warm":
    case "social_dark":
      return [
        { segmentId: "stage_flow", actionIds: [`fixed-${stageKey.includes("warm") ? "social-warm" : "social-dark"}-approach-1`, `fixed-${stageKey.includes("warm") ? "social-warm" : "social-dark"}-approach-2`, "fixed-social-gift-1", "fixed-social-gift-2", "fixed-social-gift-3", "fixed-social-gift-4", "fixed-social-gift-5", "fixed-social-talk-1", "fixed-social-talk-2", "fixed-social-talk-3", "fixed-social-talk-4", "fixed-social-talk-5"], skipTo: SKIP_TO_NEXT_STAGE }
      ];
    case "dark_close":
      return [
        {
          segmentId: "round_flow",
          actionIds: roundNumber === 1
            ? ["fixed-dark-close-1", "fixed-dark-close-2", "fixed-dark-close-3", "fixed-dark-close-4", "fixed-dark-close-5", "fixed-dark-close-loot-collect", "fixed-dark-close-6", "fixed-dark-close-7"]
            : ["fixed-dark-close-3", "fixed-dark-close-4", "fixed-dark-close-5", "fixed-dark-close-loot-collect", "fixed-dark-close-6", "fixed-dark-close-7"],
          skipTo: SKIP_TO_NEXT_TURN
        }
      ];
    case "dark_miaoqu":
      return [
        { segmentId: "round_flow", actionIds: ["fixed-dark-miaoqu-1", "fixed-dark-miaoqu-2", "fixed-dark-miaoqu-3", "fixed-dark-miaoqu-4"], skipTo: SKIP_TO_NEXT_TURN }
      ];
    case "ending_trade":
      return [
        { segmentId: "stage_flow", actionIds: ["fixed-ending-trade-1", "fixed-ending-trade-2", "fixed-ending-trade-3", "fixed-ending-trade-4", "fixed-ending-trade-5", "fixed-ending-trade-6", "fixed-ending-trade-7", "fixed-ending-trade-8", "fixed-ending-trade-9"], skipTo: SKIP_TO_NEXT_STAGE }
      ];
    default:
      return [];
  }
}

function getStageSequenceForAutomation() {
  return buildAutomationStageSequence(getState().automation?.stageKeys);
}

function findStageSequenceIndex(stageKey) {
  return getStageSequenceForAutomation().findIndex((stage) => stage.key === stageKey);
}

function buildFirstSegmentTarget(stageKey, roundNumber) {
  const segments = buildFixedStageSegments(stageKey, roundNumber);
  const firstSegmentId = segments[0]?.segmentId || null;
  return firstSegmentId
    ? { stageKey, roundNumber, segmentId: firstSegmentId }
    : null;
}

function buildNextTurnTarget(stageKey, roundNumber) {
  const stageIndex = findStageSequenceIndex(stageKey);
  const stageSequence = getStageSequenceForAutomation();
  const stage = stageIndex >= 0 ? stageSequence[stageIndex] : null;
  if (!stage) {
    return null;
  }
  if (roundNumber < stage.rounds) {
    return buildFirstSegmentTarget(stageKey, roundNumber + 1);
  }
  const nextStage = stageSequence[stageIndex + 1] || null;
  if (!nextStage) {
    return { stageKey: null, roundNumber: null, segmentId: null, terminal: "completed" };
  }
  return buildFirstSegmentTarget(nextStage.key, 1);
}

function resolveSkipToTarget(stageKey, roundNumber, segmentId) {
  const segments = buildFixedStageSegments(stageKey, roundNumber);
  const segment = segments.find((item) => item.segmentId === segmentId) || null;
  if (!segment) {
    return null;
  }
  if (segment.skipTo === SKIP_TO_NEXT_TURN || segment.skipTo === SKIP_TO_NEXT_STAGE) {
    return buildNextTurnTarget(stageKey, roundNumber);
  }
  return {
    stageKey,
    roundNumber,
    segmentId: segment.skipTo
  };
}

function findSegmentForAction(stageKey, roundNumber, actionId) {
  const normalizedActionId = String(actionId || "").trim();
  const segments = buildFixedStageSegments(stageKey, roundNumber);
  return segments.find((segment) => segment.actionIds.includes(normalizedActionId)) || segments[0] || null;
}

function buildSegmentEntryActions(stageKey, roundNumber, segmentId) {
  const actions = buildStageStartActions(stageKey, roundNumber);
  const segment = buildFixedStageSegments(stageKey, roundNumber).find((item) => item.segmentId === segmentId) || null;
  if (!segment) {
    return actions;
  }
  return sliceActionsFromId(actions, segment.actionIds[0]);
}

function buildRuntimePointerResumeContext({
  failureCode = null,
  failedStepTitle = null
} = {}) {
  const runtimeState = getState();
  const automation = runtimeState.automation || {};
  const upcomingTurn = getUpcomingScriptTurn(automation);
  const stage = upcomingTurn?.stage || null;
  const roundNumber = Math.max(1, Number(upcomingTurn?.roundNumber || 1));

  if (!stage?.key) {
    return null;
  }

  const segments = buildFixedStageSegments(stage.key, roundNumber);
  const activeSegmentId = String(
    automation.failedSegmentId
      || automation.currentSegmentId
      || segments[0]?.segmentId
      || ""
  ).trim();

  if (!activeSegmentId) {
    return null;
  }

  const userInstruction = String(
    automation.instruction
      || runtimeState.agent?.lastUserInstruction
      || ""
  ).trim();
  const perception = runtimeState.latestPerception || null;
  const plan = buildFixedScriptPlan({
    stage,
    roundNumber,
    scene: perception,
    userInstruction
  });
  const resolvedFailedStepTitle = String(
    failedStepTitle
      || getFixedStageProgressText(stage.key, roundNumber, activeSegmentId)
      || activeSegmentId
      || stage.key
  ).trim();

  return {
    stage,
    roundNumber,
    stageKey: stage.key,
    failedActionId: "",
    failedSegmentId: activeSegmentId,
    failedStepTitle: resolvedFailedStepTitle,
    failureCode: failureCode || automation.lastFailureCode || null,
    failureMessageId: null,
    recoveryKind: "recovery_anchor_resolution",
    completedActionIds: [],
    chunkWorkerActions: [],
    attemptCount: 0,
    attemptBudget: 0,
    workerActions: [],
    skipTarget: resolveSkipToTarget(stage.key, roundNumber, activeSegmentId),
    userInstruction,
    scene: perception,
    perception,
    interactionMode: runtimeState.interactionMode || "act",
    externalInputGuardEnabled: runtimeState.externalInputGuardEnabled !== false,
    perceptionSummary: perceptionSummaryBySource(perception, "agent"),
    plan
  };
}

function buildRecoveryActionsFromAnchor(context, anchorState) {
  const stageKey = String(context?.stage?.key || "");
  const roundNumber = Math.max(1, Number(context?.roundNumber || 1));
  const anchorId = String(anchorState?.anchorId || "unknown");
  const failedActionId = String(context?.failedActionId || "");

  if (stageKey === "social_warm" || stageKey === "social_dark") {
    if (anchorId === "chat_ready") {
      return { recoveryKind: "npc_reply_loop", workerActions: [], anchorId };
    }
    if (["gift_screen", "npc_action_menu", "small_talk_menu", "small_talk_confirm", "trade_screen"].includes(anchorId)) {
      const workerActions = buildSocialResumeActionsForCurrentStage(context.stage, anchorId);
      return { recoveryKind: "worker_actions", workerActions, anchorId };
    }
    return {
      recoveryKind: "worker_actions",
      workerActions: createFixedSocialStageActions(stageKey),
      anchorId: anchorId || "safe_anchor"
    };
  }

  if (stageKey === "sell_loop") {
    const actions = createFixedSellLoopActions({ roundNumber });
    if (anchorId === "vendor_purchase_screen") {
      return {
        recoveryKind: "worker_actions",
        workerActions: sliceActionsFromId(actions, "fixed-sale-5"),
        anchorId
      };
    }
    if (anchorId === "hawking_screen") {
      return {
        recoveryKind: "worker_actions",
        workerActions: sliceActionsFromId(actions, "fixed-sale-10"),
        anchorId
      };
    }
    if (anchorId === "hawking_runtime_active" || anchorId === "hawking_runtime_ready") {
      if (anchorId === "hawking_runtime_active") {
        return {
          recoveryKind: "worker_actions",
          workerActions: [{
            id: "fixed-sale-recovery-runtime-finish",
            title: "等当前叫卖运行态自然卖完回到正常街道",
            type: "wait_hawking_runtime_finish",
            finishTimeoutMs: 120000
          }],
          anchorId
        };
      }
      return {
        recoveryKind: "stage_completed",
        workerActions: [],
        anchorId
      };
    }
    if (anchorId === "world_hud") {
      const postBuyIds = new Set(["fixed-sale-6", "fixed-sale-7", "fixed-sale-8", "fixed-sale-9", "fixed-sale-10", "fixed-sale-11"]);
      const workerActions = postBuyIds.has(failedActionId)
        ? sliceActionsFromId(actions, "fixed-sale-9")
        : sliceActionsFromId(actions, "fixed-sale-3");
      return { recoveryKind: "worker_actions", workerActions, anchorId };
    }
    return {
      recoveryKind: "worker_actions",
      workerActions: actions,
      anchorId: anchorId || "safe_anchor"
    };
  }

  if (stageKey === "dark_close") {
    const actions = createFixedDarkCloseStageActions({ roundNumber });
    if (anchorId === "stealth_ready") {
      return {
        recoveryKind: "worker_actions",
        workerActions: sliceActionsFromId(actions, "fixed-dark-close-4"),
        anchorId
      };
    }
    if (anchorId === "knockout_context") {
      return {
        recoveryKind: "worker_actions",
        workerActions: sliceActionsFromId(actions, "fixed-dark-close-5"),
        anchorId
      };
    }
    if (anchorId === "loot_screen") {
      return {
        recoveryKind: "worker_actions",
        workerActions: sliceActionsFromId(actions, "fixed-dark-close-loot-collect"),
        anchorId
      };
    }
    if (anchorId === "world_hud") {
      const workerActions = roundNumber === 1
        ? sliceActionsFromId(actions, "fixed-dark-close-3")
        : createFixedDarkCloseStageActions({ roundNumber: 2 });
      return { recoveryKind: "worker_actions", workerActions, anchorId };
    }
    return {
      recoveryKind: "worker_actions",
      workerActions: actions,
      anchorId: anchorId || "safe_anchor"
    };
  }

  if (stageKey === "dark_miaoqu") {
    const actions = createFixedDarkMiaoquStageActions();
    if (anchorId === "stealth_ready") {
      return {
        recoveryKind: "worker_actions",
        workerActions: sliceActionsFromId(actions, "fixed-dark-miaoqu-2"),
        anchorId
      };
    }
    if (anchorId === "steal_screen") {
      return {
        recoveryKind: "worker_actions",
        workerActions: sliceActionsFromId(actions, "fixed-dark-miaoqu-3"),
        anchorId
      };
    }
    if (anchorId === "world_hud") {
      return {
        recoveryKind: "worker_actions",
        workerActions: actions,
        anchorId
      };
    }
    return {
      recoveryKind: "worker_actions",
      workerActions: actions,
      anchorId: anchorId || "safe_anchor"
    };
  }

  if (stageKey === "ending_trade") {
    if (anchorId === "trade_screen") {
      return {
        recoveryKind: "worker_actions",
        workerActions: createFixedEndingTradeBundleActions({ idPrefix: "fixed-ending-trade-recovery-bundle" }),
        anchorId
      };
    }
    if (anchorId === "npc_action_menu") {
      return {
        recoveryKind: "worker_actions",
        workerActions: [
          ...createFixedEndingTradeOpenTradeActions({
            idPrefix: "fixed-ending-trade-recovery-open",
            acquireTitle: "沿用当前锁定目标继续拉交易页",
            menuTitle: "沿用当前交互菜单继续打开交易页",
            tradeTitle: "从当前菜单继续打开交易页准备收尾卖货"
          }).slice(2),
          ...createFixedEndingTradeBundleActions({ idPrefix: "fixed-ending-trade-recovery-bundle" })
        ],
        anchorId
      };
    }
    if (anchorId === "world_hud") {
      return {
        recoveryKind: "worker_actions",
        workerActions: [
          ...createFixedEndingTradeRelocateActions({ idPrefix: "fixed-ending-trade-recovery-relocate" }),
          ...createFixedEndingTradeOpenTradeActions({
            idPrefix: "fixed-ending-trade-recovery-open",
            acquireTitle: "回到卦摊附近重新锁一个路人目标",
            menuTitle: "回到卦摊附近重新拉起路人交互菜单",
            tradeTitle: "回到卦摊附近重新打开交易页准备收尾卖货"
          }),
          ...createFixedEndingTradeBundleActions({ idPrefix: "fixed-ending-trade-recovery-bundle" })
        ],
        anchorId
      };
    }
    return {
      recoveryKind: "worker_actions",
      workerActions: createFixedEndingTradeActions(),
      anchorId: anchorId || "safe_anchor"
    };
  }

  return {
    recoveryKind: "worker_actions",
    workerActions: buildStageStartActions(stageKey, roundNumber),
    anchorId: anchorId || "safe_anchor"
  };
}

function buildLowRiskRecoveryProbeActions(context, anchorState) {
  const anchorId = String(anchorState?.anchorId || "");
  const stageKey = String(context?.stage?.key || "");
  if (["trade_screen", "gift_screen", "npc_action_menu", "small_talk_menu", "small_talk_confirm", "chat_ready"].includes(anchorId)) {
    return [{
      id: "resume-low-risk-close",
      title: "先轻关当前面板再重判恢复锚点",
      type: "close_current_panel"
    }];
  }
  if (stageKey === "dark_miaoqu" && anchorId === "steal_screen") {
    return [{
      id: "resume-low-risk-exit-stealth",
      title: "先退潜行回稳定主界面再重判",
      type: "exit_stealth",
      settleMs: 250
    }];
  }
  return [];
}

function buildFixedScriptOpeningThinkingChain(stageKey, thinkingChain) {
  if (stageKey === "street_wander") {
    // Stage 0 thoughts should be interleaved with movement commentary instead
    // of being dumped in the opening bubble all at once.
    return [];
  }
  if (!Array.isArray(thinkingChain) || thinkingChain.length === 0) {
    return [];
  }
  return [String(thinkingChain[0] || "").trim()].filter(Boolean);
}

const FIXED_SCRIPT_STAGES = [
  {
    key: "street_wander",
    rounds: 1,
    instructionLabel: "先原地乱跑乱晃，把街上的热闹看进脑子里再决定第一笔钱从哪儿挣。",
    riskLevel: "low",
    actionTypes: ["wander"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("street_wander", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("street_wander", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("street_wander", roundNumber).persona
  },
  {
    key: "sell_loop",
    rounds: 2,
    instructionLabel: "先走正路买货叫卖，看看这条钱路能不能撑起来。",
    riskLevel: "low",
    actionTypes: ["sale"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("sell_loop", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("sell_loop", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("sell_loop", roundNumber).persona
  },
  {
    key: "social_warm",
    rounds: 1,
    instructionLabel: "先去第一个卦摊只聊一个人，固定开场吹嘘籽岷，送礼后死缠烂打地让对方记住籽岷。",
    riskLevel: "low",
    actionTypes: ["gift", "talk"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("social_warm", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("social_warm", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("social_warm", roundNumber).persona
  },
  {
    key: "social_dark",
    rounds: 1,
    instructionLabel: "再去第二个卦摊只聊一个人，围绕搞钱先正常追问四轮，再黑化追问四轮。",
    riskLevel: "medium",
    actionTypes: ["gift", "talk"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("social_dark", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("social_dark", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("social_dark", roundNumber).persona
  },
  {
    key: "dark_close",
    rounds: 2,
    instructionLabel: "正常路已经太慢了，直接潜行、闷棍、扛走、搜刮。",
    riskLevel: "high",
    actionTypes: ["stealth", "strike"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("dark_close", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("dark_close", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("dark_close", roundNumber).persona
  },
  {
    key: "dark_miaoqu",
    rounds: 6,
    instructionLabel: "正面放倒太显眼了，接下来只做独立妙取和脱离。",
    riskLevel: "high",
    actionTypes: ["stealth", "steal"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("dark_miaoqu", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("dark_miaoqu", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("dark_miaoqu", roundNumber).persona
  },
  {
    key: "ending_trade",
    rounds: 1,
    instructionLabel: "最后就在原地找个路人把货卖掉，干净利落收尾。",
    riskLevel: "low",
    actionTypes: ["trade"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("ending_trade", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("ending_trade", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("ending_trade", roundNumber).persona
  }
];

let turnInFlight = false;
let pendingResumeContext = null;
let latestCaptureImageDataUrl = null;
const SKIP_TO_NEXT_TURN = "__NEXT_TURN__";
const SKIP_TO_NEXT_STAGE = "__NEXT_STAGE__";

function cloneStageWithOverrides(stage, overrides = {}) {
  return {
    ...stage,
    ...overrides,
    actionTypes: Array.isArray(overrides.actionTypes)
      ? [...overrides.actionTypes]
      : [...stage.actionTypes]
  };
}

function buildAutomationStageSequence(stageKeys = null) {
  if (!Array.isArray(stageKeys) || stageKeys.length === 0) {
    return FIXED_SCRIPT_STAGES;
  }

  return stageKeys
    .map((stageKey) => {
      const stage = FIXED_SCRIPT_STAGES.find((entry) => entry.key === stageKey);
      if (!stage) {
        return null;
      }
      if (stageKey === "dark_close" || stageKey === "dark_miaoqu") {
        return cloneStageWithOverrides(stage, { rounds: 1 });
      }
      return stage;
    })
    .filter(Boolean);
}

function getAutomationTriggerConfig(instruction) {
  const text = String(instruction || "");

  if (text.includes("我想敲他板砖")) {
    return {
      triggerWord: "我想敲他板砖",
      stageKeys: ["dark_close"],
      armedNotice: "收到，这轮直接走敲板砖的整套黑活：跑图、潜行、种蛊、闷棍、搜刮、后撤。",
      armedObjective: "先留两分钟鼠标脱离时间，之后直接跑敲板砖整套黑活。"
    };
  }

  if (text.includes("我想偷点东西")) {
    return {
      triggerWord: "我想偷点东西",
      stageKeys: ["dark_miaoqu"],
      armedNotice: "收到，这轮直接走妙取整套黑活：跑图、潜行、妙取、点击、后撤。",
      armedObjective: "先留两分钟鼠标脱离时间，之后直接跑妙取整套黑活。"
    };
  }

  if (text.includes("加油")) {
    return {
      triggerWord: "加油",
      stageKeys: null,
      armedNotice: "收到加油啦！马上动脑筋～",
      armedObjective: "先留两分钟鼠标脱离时间，之后再按既定安排动手"
    };
  }

  return null;
}

function getStealthStageTallies() {
  const automation = getState().automation || {};
  const tallies = automation.stealthStageTallies || {};
  return {
    darkClose: {
      success: Number(tallies?.dark_close?.success || 0),
      failure: Number(tallies?.dark_close?.failure || 0)
    },
    darkMiaoqu: {
      success: Number(tallies?.dark_miaoqu?.success || 0),
      failure: Number(tallies?.dark_miaoqu?.failure || 0)
    }
  };
}

function buildStealthSummaryText() {
  const tallies = getStealthStageTallies();
  const darkCloseTotal = tallies.darkClose.success + tallies.darkClose.failure;
  const darkMiaoquTotal = tallies.darkMiaoqu.success + tallies.darkMiaoqu.failure;
  const totalSuccess = tallies.darkClose.success + tallies.darkMiaoqu.success;
  const totalFailure = tallies.darkClose.failure + tallies.darkMiaoqu.failure;
  return {
    tallies,
    darkCloseTotal,
    darkMiaoquTotal,
    totalSuccess,
    totalFailure
  };
}

function buildFixedStealthSummaryVoiceOverride(stageKey, roundNumber) {
  if (stageKey !== "ending_trade") {
    return null;
  }

  const { tallies, totalSuccess, totalFailure } = buildStealthSummaryText();
  const darkCloseSummary = `闷棍搜刮 ${tallies.darkClose.success} 成 ${tallies.darkClose.failure} 败`;
  const darkMiaoquSummary = `妙取 ${tallies.darkMiaoqu.success} 成 ${tallies.darkMiaoqu.failure} 败`;

  let thinkingChain;
  let decide;
  let persona;
  let finishText;

  if (totalSuccess === 0 && totalFailure > 0) {
    thinkingChain = [
      `前头黑活一口没咬下来，${darkCloseSummary}，${darkMiaoquSummary}。`,
      "这会儿别再逞强了，先把手里还能卖的货顺出去，至少别让今天白折腾。",
      "收尾得放低姿态一点，把残存的进账捞回来，比嘴硬重要。"
    ];
    decide = `前面几手都没成，我先老老实实把尾货卖掉止损：${darkCloseSummary}，${darkMiaoquSummary}。`;
    persona = "前头黑活扑空了，收尾就别装潇洒，先把还能落袋的钱收回来。";
    finishText = "这波黑活几乎全空了，我先把能卖的尾货收住，免得今天只剩一地狼狈。";
  } else if (totalFailure === 0 && totalSuccess > 0) {
    thinkingChain = [
      `前头这波黑活手感正顺，${darkCloseSummary}，${darkMiaoquSummary}。`,
      "该拿的已经拿到了，最后这笔交易只要收得干净，今天就算连黑带白一起落袋。",
      "这会儿不用慌，按节奏把尾货清掉，整趟活就漂亮收官了。"
    ];
    decide = `前头手感不错，我把最后这批货顺出去就能体面收工：${darkCloseSummary}，${darkMiaoquSummary}。`;
    persona = "黑活顺得很，收尾这笔交易更要稳，把今天的账面漂亮拍平。";
    finishText = "前头黑活打得很顺，这会儿把尾货一清，今天这趟就算又黑又稳地赚到了。";
  } else {
    thinkingChain = [
      `前头这波黑活有成有空，${darkCloseSummary}，${darkMiaoquSummary}。`,
      "手感不算完美，但也不是白忙一场；最后这笔交易得把能落袋的都落袋。",
      "收尾这一下最重要的是别再失手，把今天这点起伏硬收成账面。"
    ];
    decide = `前面有成有败，我先把剩下的货卖掉，把今天这趟战果收拢：${darkCloseSummary}，${darkMiaoquSummary}。`;
    persona = "前头黑活有赚有漏，最后靠交易把成绩单收紧，别让前面的波动白白散掉。";
    finishText = "前头有几下成了，也有几下空了；尾货卖干净，今天这趟成绩就还算站得住。";
  }

  return {
    thinkingChain,
    decide,
    persona,
    progress: {
      target: `先找个路人把最后这笔交易做完，顺手把战果也收个总账：${darkCloseSummary}，${darkMiaoquSummary}。`,
      trade: `交易页既然开了，我就一边卖一边记着前头总共打成了多少手：${darkCloseSummary}，${darkMiaoquSummary}。`,
      finish: finishText
    },
    resultFactory: ({ recovered }) => recovered
      ? `${finishText} 收尾虽然磕绊了一下，但最后还是把尾货顺出去了。`
      : `${finishText} ${darkCloseSummary}，${darkMiaoquSummary}。`
  };
}

const autoCaptureService = createAutoCaptureService({
  captureWindow: () => captureGameWindow(),
  analyzeScreenshot,
  intervalMs: CAPTURE_INTERVAL_MS,
  onPerception: (perception, meta) => {
    latestCaptureImageDataUrl = meta?.imageDataUrl || latestCaptureImageDataUrl;
    const { imageDataUrl, ...perceptionMeta } = meta || {};
    setLatestPerception(perception, perceptionMeta);
    setCaptureState({
      lastImageSource: "auto_window"
    });
  },
  onStateChange: (captureState) => {
    setCaptureState(captureState);
  },
  onLog: (level, message, meta = null) => {
    appendLog(level, message, meta);
  }
});

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function handleExternalInputInterrupted(error, contextLabel) {
  if (error?.code !== "EXTERNAL_INPUT_INTERRUPTED") {
    return false;
  }

  const runtimePointerContext = buildRuntimePointerResumeContext({
    failureCode: error.code,
    failedStepTitle: String(
      error?.workerPayload?.failedStep?.title
        || error?.workerPayload?.failedStep?.type
        || ""
    ).trim() || null
  });

  setStatus("paused");
  autoCaptureService.pause();
  updateAutomation({
    status: "paused"
  });
  if (runtimePointerContext) {
    setPendingResumeContext(runtimePointerContext);
  }
  updateAgent({
    phase: "waiting"
  });
  setLastError(error.message);
  appendLog("info", `${contextLabel}因外部鼠标或键盘输入已暂停`, {
    error: error.message,
    failedStep: error.workerPayload?.failedStep || error.failed_step || null
  });
  return true;
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    throw new Error("imageDataUrl must be a valid image data URL");
  }

  return imageDataUrl;
}

function requireAudioDataUrl(audioDataUrl) {
  if (typeof audioDataUrl !== "string" || !/^data:audio\/[a-z0-9.+-]+;base64,/i.test(audioDataUrl)) {
    throw new Error("audioDataUrl must be a valid audio data URL");
  }

  return audioDataUrl;
}

function parseAudioDataUrl(audioDataUrl) {
  const normalized = requireAudioDataUrl(audioDataUrl);
  const match = normalized.match(/^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i);

  if (!match) {
    throw new Error("audioDataUrl must include audio mime type and base64 payload");
  }

  const mimeSubtype = match[1].toLowerCase();
  const extensionMap = {
    mpeg: "mp3",
    mpga: "mp3",
    wav: "wav",
    "x-wav": "wav",
    webm: "webm",
    ogg: "ogg",
    mp4: "m4a",
    aac: "aac"
  };

  return {
    extension: extensionMap[mimeSubtype] || "wav",
    buffer: Buffer.from(match[2], "base64")
  };
}

async function writeTempAudioFile(audioDataUrl) {
  const { extension, buffer } = parseAudioDataUrl(audioDataUrl);
  const filePath = path.join(
    os.tmpdir(),
    `moonlight-blade-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`
  );
  await writeFile(filePath, buffer);
  return filePath;
}

function statePayload() {
  return {
    ok: true,
    state: getState(),
    actionCatalog: buildActionCatalog()
  };
}

function createActionSteps(actionTypes, decide) {
  return actionTypes.map((actionType, index) => ({
    id: `script-plan-${index + 1}`,
    type: actionType,
    title: actionType,
    reason: decide,
    detail: decide
  }));
}

function buildFixedScriptPlan({ stage, roundNumber, scene, userInstruction }) {
  const thinkingChain = stage.thinkingFactory({ roundNumber, userInstruction });
  const decide = String(stage.decideFactory({ roundNumber, userInstruction }) || "").trim();
  const personaInterpretation = String(stage.personaFactory({ roundNumber, userInstruction }) || decide).trim();
  const actionTypes = [...stage.actionTypes];

  return {
    intent: `${stage.instructionLabel} 第 ${roundNumber} 轮`,
    personaInterpretation,
    environment: sceneDescription(scene),
    candidateStrategies: actionTypes,
    selectedStrategy: actionTypes.join(" -> "),
    riskLevel: stage.riskLevel,
    thinkingChain,
    recoveryLine: "这一步要是没走通，我就先把现场留住，再按既定顺序补上。",
    actions: createActionSteps(actionTypes, decide),
    decide,
    scriptKey: stage.key,
    scriptRoundNumber: roundNumber,
    userInstruction
  };
}

function findFixedScriptStage(stageKey) {
  const normalized = String(stageKey || "").trim();
  if (!normalized) {
    return null;
  }
  return FIXED_SCRIPT_STAGES.find((stage) => stage.key === normalized) || null;
}

function getUpcomingScriptTurn(automationState) {
  const stageSequence = buildAutomationStageSequence(automationState?.stageKeys);
  const stage = stageSequence[automationState.stageIndex];

  if (!stage) {
    return null;
  }

  return {
    stage,
    roundNumber: automationState.completedRoundsInStage + 1
  };
}

function advanceAutomationProgress(automationState) {
  const stageSequence = buildAutomationStageSequence(automationState?.stageKeys);
  const stage = stageSequence[automationState.stageIndex];

  if (!stage) {
    return {
      status: "completed",
      finishedAt: new Date().toISOString()
    };
  }

  const completedRoundsInStage = automationState.completedRoundsInStage + 1;

  if (completedRoundsInStage < stage.rounds) {
    return {
      stageIndex: automationState.stageIndex,
      completedRoundsInStage
    };
  }

  const nextStageIndex = automationState.stageIndex + 1;

  if (!stageSequence[nextStageIndex]) {
    return {
      stageIndex: nextStageIndex,
      completedRoundsInStage: 0,
      status: "completed",
      finishedAt: new Date().toISOString()
    };
  }

  return {
    stageIndex: nextStageIndex,
    completedRoundsInStage: 0
  };
}

function armAutomationScript(instruction, triggerConfig = null) {
  clearPendingResumeContext();
  const now = new Date();
  const startsAt = new Date(now.getTime() + SCRIPT_START_PROTECTION_DELAY_MS);
  autoCaptureService.stop();

  updateAutomation({
    status: "armed",
    instruction,
    armedAt: now.toISOString(),
    armedActionKind: "script_start",
    startsAt: startsAt.toISOString(),
    inputProtectionUntil: startsAt.toISOString(),
    inputProtectionButton: "submit",
    startedAt: null,
    finishedAt: null,
    stageIndex: 0,
    stageKeys: triggerConfig?.stageKeys || null,
    completedRoundsInStage: 0,
    totalTurns: 0,
    lastThought: null,
    lastOutcome: null,
    lastFailureCode: null,
    lastRecoveryKind: null,
    lastRecoveryAttemptCount: 0,
    stealthStageTallies: {
      dark_close: { success: 0, failure: 0 },
      dark_miaoqu: { success: 0, failure: 0 }
    },
    currentSegmentId: null,
    failedSegmentId: null,
    skipAvailable: false,
    skipTargetStageKey: null,
    skipTargetSegmentId: null,
    skipRequestedAt: null,
    skipSourceSegmentId: null
  });

  updateAgent({
    mode: "autonomous",
    phase: "armed",
    currentObjective: triggerConfig?.armedObjective || "先留两分钟鼠标脱离时间，之后再按既定安排动手",
    queuedUserObjective: instruction,
    lastUserInstruction: instruction
  });
}

function armResumeFailedStep() {
  const context = pendingResumeContext || buildRuntimePointerResumeContext();
  const hasRecoveryContext = Boolean(context?.stage?.key || context?.recoveryKind === "npc_reply_loop");
  if (!hasRecoveryContext) {
    throw new Error("当前没有可继续的失败步骤。");
  }
  if (!pendingResumeContext && context) {
    setPendingResumeContext(context);
  }

  const now = new Date();
  const startsAt = new Date(now.getTime() + FOLLOWUP_PROTECTION_DELAY_MS);
  setStatus("running");
  autoCaptureService.stop();
  setLastError(null);
  updateAutomation({
    status: "armed",
    armedAt: now.toISOString(),
    armedActionKind: "resume_failed_step",
    startsAt: startsAt.toISOString(),
    inputProtectionUntil: startsAt.toISOString(),
    inputProtectionButton: "resume",
    resumeAvailable: false,
    resumeFailedStepTitle: context.failedStepTitle || null
  });
  updateAgent({
    mode: "autonomous",
    phase: "armed",
    currentObjective: `先留两分钟鼠标脱离时间，之后从「${context.failedStepTitle || "失败步骤"}」继续`,
    lastAutonomousInstruction: context.plan?.intent || getState().agent.lastAutonomousInstruction
  });
}

function hasAutomationTrigger(instruction) {
  return Boolean(getAutomationTriggerConfig(instruction));
}

function armSkipFailedSegment() {
  const context = pendingResumeContext || buildRuntimePointerResumeContext();
  if (!context?.skipTarget) {
    throw new Error("当前失败环节没有可跳过的后继入口。");
  }
  if (!pendingResumeContext && context) {
    setPendingResumeContext(context);
  }

  const now = new Date();
  const startsAt = new Date(now.getTime() + FOLLOWUP_PROTECTION_DELAY_MS);
  setStatus("running");
  autoCaptureService.stop();
  setLastError(null);
  updateAutomation({
    status: "armed",
    armedAt: now.toISOString(),
    armedActionKind: "skip_failed_segment",
    startsAt: startsAt.toISOString(),
    inputProtectionUntil: startsAt.toISOString(),
    inputProtectionButton: "skip",
    resumeAvailable: false,
    skipAvailable: false,
    skipRequestedAt: now.toISOString()
  });
  updateAgent({
    mode: "autonomous",
    phase: "armed",
    currentObjective: `先留两分钟鼠标脱离时间，之后跳过「${context.failedSegmentId || context.failedStepTitle || "失败环节"}」`,
    lastAutonomousInstruction: context.plan?.intent || getState().agent.lastAutonomousInstruction
  });
}

function hasChatAssistTrigger(instruction) {
  return String(instruction || "").includes("帮我聊吧");
}

function stopChatAssist({
  reason = "stopped",
  message = "",
  appendNotice = false,
  riskLevel = "low"
} = {}) {
  const latestState = getState();
  updateAutomation({
    status: "idle",
    mode: null,
    instruction: null,
    armedAt: null,
    armedActionKind: null,
    startsAt: null,
    inputProtectionUntil: null,
    inputProtectionButton: null,
    startedAt: null,
    finishedAt: latestState.automation?.status === "chat_assist" ? new Date().toISOString() : latestState.automation?.finishedAt || null,
    stageIndex: 0,
    completedRoundsInStage: 0,
    totalTurns: 0,
    lastThought: null,
    lastOutcome: reason,
    lastFailureCode: null,
    lastRecoveryKind: null,
    lastRecoveryAttemptCount: 0,
    stealthStageTallies: {
      dark_close: { success: 0, failure: 0 },
      dark_miaoqu: { success: 0, failure: 0 }
    },
    currentSegmentId: null,
    failedSegmentId: null,
    skipAvailable: false,
    skipTargetStageKey: null,
    skipTargetSegmentId: null,
    skipRequestedAt: null,
    skipSourceSegmentId: null,
    chatAssistLastDialogText: null,
    chatAssistRounds: [],
    resumeAvailable: false,
    resumeFailedStepTitle: null
  });
  updateAgent({
    mode: "autonomous",
    phase: "waiting",
    currentObjective: "等待下一句指令",
    queuedUserObjective: null
  });
  if (appendNotice && message) {
    appendMessage({
      role: "assistant",
      text: message,
      thinkingChain: [],
      perceptionSummary: perceptionSummaryBySource(latestState.latestPerception, "agent"),
      sceneLabel: latestState.latestPerception?.sceneLabel || "聊天代打已停止",
      riskLevel,
      actions: [],
      decide: ""
    });
  }
}

function armChatAssist(instruction) {
  clearPendingResumeContext();
  setStatus("running");
  updateAutomation({
    status: "chat_assist",
    mode: "chat_assist",
    instruction,
    armedAt: null,
    armedActionKind: null,
    startsAt: null,
    inputProtectionUntil: null,
    inputProtectionButton: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stageIndex: 0,
    completedRoundsInStage: 0,
    totalTurns: 0,
    lastThought: null,
    lastOutcome: null,
    lastFailureCode: null,
    lastRecoveryKind: null,
    lastRecoveryAttemptCount: 0,
    currentSegmentId: null,
    failedSegmentId: null,
    skipAvailable: false,
    skipTargetStageKey: null,
    skipTargetSegmentId: null,
    skipRequestedAt: null,
    skipSourceSegmentId: null,
    chatAssistLastDialogText: null,
    chatAssistRounds: [],
    resumeAvailable: false,
    resumeFailedStepTitle: null
  });
  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: "盯当前聊天页并帮忙续聊",
    queuedUserObjective: instruction,
    lastUserInstruction: instruction
  });
  ensureAutoCaptureRunning();
}

function mergeWorkerExecutions(executions = []) {
  const normalizedExecutions = executions.filter(Boolean);
  return {
    executor: "WindowsInputExecutor",
    steps: normalizedExecutions.flatMap((execution) => execution.steps || []),
    rawSteps: normalizedExecutions.flatMap((execution) => execution.rawSteps || []),
    durationMs: normalizedExecutions.reduce((sum, execution) => sum + (execution.durationMs || 0), 0),
    outcome: normalizedExecutions.at(-1)?.outcome || "当前没有可汇总的固定剧本执行结果。"
  };
}

function getFailureCode(error) {
  return String(error?.code || error?.workerPayload?.errorCode || "INPUT_EXECUTION_FAILED").trim();
}

function getFailureAttemptCount(error) {
  return Number(
    error?.workerPayload?.failedStep?.input?.attemptCount
      || error?.workerPayload?.failedStep?.input?.retryCount
      || 0
  );
}

function buildStageWorkerActions(stageKey) {
  switch (stageKey) {
    case "street_wander":
      return createFixedStreetWanderActions();
    case "sell_loop":
      return createFixedSellLoopActions();
    case "social_warm":
    case "social_dark":
      return createFixedSocialStageActions(stageKey);
    case "dark_close":
      return createFixedDarkCloseStageActions();
    case "dark_miaoqu":
      return createFixedDarkMiaoquStageActions();
    case "ending_trade":
      return createFixedEndingTradeActions();
    default:
      return [];
  }
}

function getRecoveryBudget(baseContext, error) {
  const failureCode = getFailureCode(error);
  const stageKey = baseContext?.stage?.key || "";

  if (stageKey === "dark_close" && ["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(failureCode)) {
    return DARK_CLOSE_RESTART_BUDGET;
  }
  if (stageKey === "dark_miaoqu" && ["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(failureCode)) {
    return DARK_CLOSE_RESTART_BUDGET;
  }
  if ((stageKey === "social_warm" || stageKey === "social_dark")
    && ["NPC_CHAT_THRESHOLD_REVEALED", "NPC_VIEW_NOT_OPENED", "NPC_TARGET_SWITCH_FAILED"].includes(failureCode)) {
    return 1;
  }
  if (failureCode === "ROUTE_STALLED") {
    return 2;
  }
  return 0;
}

function clearPendingResumeContext({ preserveFailureMeta = false } = {}) {
  pendingResumeContext = null;
  updateAutomation({
    resumeAvailable: false,
    resumeFailedStepTitle: null,
    skipAvailable: false,
    failedSegmentId: null,
    skipTargetStageKey: null,
    skipTargetSegmentId: null,
    skipRequestedAt: null,
    skipSourceSegmentId: null,
    armedActionKind: null,
    inputProtectionUntil: null,
    inputProtectionButton: null,
    ...(preserveFailureMeta
      ? {}
      : {
        lastFailureCode: null,
        lastRecoveryKind: null,
        lastRecoveryAttemptCount: 0
      })
  });
}

function setPendingResumeContext(context) {
  pendingResumeContext = context || null;
  updateAutomation({
    resumeAvailable: Boolean(context),
    resumeFailedStepTitle: context?.failedStepTitle || null,
    skipAvailable: Boolean(context?.skipTarget),
    failedSegmentId: context?.failedSegmentId || null,
    skipTargetStageKey: context?.skipTarget?.stageKey || null,
    skipTargetSegmentId: context?.skipTarget?.segmentId || null,
    skipSourceSegmentId: context?.failedSegmentId || null,
    lastFailureCode: context?.failureCode || null,
    lastRecoveryKind: context?.recoveryKind || null,
    lastRecoveryAttemptCount: context?.attemptCount || 0
  });
}

function getFailedStepTitle(error) {
  return String(
    error?.workerPayload?.failedStep?.title
      || error?.workerPayload?.failedStep?.type
      || error?.workerPayload?.failedStep?.sourceType
      || "这一步"
  ).trim();
}

function buildResumeContextFromError(baseContext, error) {
  const workerActions = Array.isArray(error?.workerActions) ? error.workerActions : [];
  const failedStep = error?.workerPayload?.failedStep || null;
  const stageKey = String(baseContext?.stage?.key || "");
  const roundNumber = Math.max(1, Number(baseContext?.roundNumber || 1));
  const completedCount = Array.isArray(error?.workerPayload?.steps) ? error.workerPayload.steps.length : 0;
  const failedActionId = String(failedStep?.id || "");
  const failedSegment = findSegmentForAction(stageKey, roundNumber, failedActionId);
  const failedSegmentId = failedSegment?.segmentId || null;
  const skipTarget = failedSegmentId
    ? resolveSkipToTarget(stageKey, roundNumber, failedSegmentId)
    : null;
  return {
    ...baseContext,
    recoveryKind: "recovery_anchor_resolution",
    failureCode: getFailureCode(error),
    failedStepTitle: getFailedStepTitle(error),
    failureMessageId: null,
    stageKey: stageKey || null,
    failedActionId,
    failedSegmentId,
    completedActionIds: workerActions.slice(0, Math.max(0, completedCount)).map((action) => String(action?.id || "")).filter(Boolean),
    chunkWorkerActions: workerActions,
    attemptCount: getFailureAttemptCount(error),
    attemptBudget: getRecoveryBudget(baseContext, error),
    workerActions: [],
    skipTarget
  };
}

function buildNpcReplyResumeContext(baseContext, error, execution) {
  return {
    ...baseContext,
    recoveryKind: "npc_reply_loop",
    failureCode: getFailureCode(error),
    failedStepTitle: getFailedStepTitle(error),
    failureMessageId: null,
    stageKey: baseContext?.stage?.key || null,
    attemptCount: 0,
    attemptBudget: 0,
    workerActions: [],
    baseExecution: execution
  };
}

async function resolveRecoveryExecutionPlan(context) {
  const maxProbeRounds = 4;
  let lastAnchorState = null;

  for (let attemptIndex = 0; attemptIndex < maxProbeRounds; attemptIndex += 1) {
    const anchorState = await inspectCurrentRecoveryAnchorState(context.externalInputGuardEnabled);
    lastAnchorState = anchorState;
    const resolved = buildRecoveryActionsFromAnchor(context, anchorState);
    const hasExecutableRecovery = resolved.recoveryKind === "npc_reply_loop"
      || resolved.recoveryKind === "stage_completed"
      || (Array.isArray(resolved.workerActions) && resolved.workerActions.length > 0);
    if (hasExecutableRecovery && anchorState.confidence !== "unknown") {
      return {
        ...resolved,
        anchorState,
        convergenceAttemptCount: attemptIndex + 1
      };
    }

    if (attemptIndex === 0) {
      await sleep(600);
      continue;
    }

    const lowRiskProbeActions = buildLowRiskRecoveryProbeActions(context, anchorState);
    if (lowRiskProbeActions.length > 0) {
      await runWindowsActions(lowRiskProbeActions, {
        interruptOnExternalInput: context.externalInputGuardEnabled
      });
      await sleep(250);
      continue;
    }

    await sleep(500);
  }

  return {
    ...buildRecoveryActionsFromAnchor(context, lastAnchorState || { anchorId: "safe_anchor", confidence: "unknown" }),
    anchorState: lastAnchorState || {
      anchorId: "safe_anchor",
      confidence: "unknown",
      evidence: {}
    },
    convergenceAttemptCount: maxProbeRounds
  };
}

function computeAutomationPositionForTarget(target) {
  if (!target?.stageKey) {
    return null;
  }
  const stageSequence = getStageSequenceForAutomation();
  const stageIndex = stageSequence.findIndex((stage) => stage.key === target.stageKey);
  if (stageIndex < 0) {
    return null;
  }
  return {
    stageIndex,
    completedRoundsInStage: Math.max(0, Number(target.roundNumber || 1) - 1)
  };
}

async function executeSkippedSegment(context) {
  const skipTarget = context?.skipTarget || null;
  if (!skipTarget) {
    throw new Error("当前失败环节没有配置 skipTo。");
  }

  if (!skipTarget.stageKey || skipTarget.terminal === "completed") {
    updateAutomation({
      status: "completed",
      finishedAt: new Date().toISOString()
    });
    updateAgent({
      phase: "waiting",
      currentObjective: "等待下一句指令"
    });
    return { mode: "completed" };
  }

  const currentStageKey = String(context?.stage?.key || "");
  const currentRoundNumber = Math.max(1, Number(context?.roundNumber || 1));
  if (skipTarget.stageKey === currentStageKey && Number(skipTarget.roundNumber || 1) === currentRoundNumber) {
    updateAutomation({
      currentSegmentId: skipTarget.segmentId || null
    });
    const actions = buildSegmentEntryActions(skipTarget.stageKey, skipTarget.roundNumber, skipTarget.segmentId);
    return {
      mode: "inline_actions",
      stage: context.stage,
      roundNumber: currentRoundNumber,
      actions
    };
  }

  const targetPosition = computeAutomationPositionForTarget(skipTarget);
  if (!targetPosition) {
    throw new Error("跳过目标没有合法的 stage 位置。");
  }

  updateAutomation({
    stageIndex: targetPosition.stageIndex,
    completedRoundsInStage: targetPosition.completedRoundsInStage,
    currentSegmentId: skipTarget.segmentId || null
  });
  return { mode: "jump_to_turn" };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function serveStatic(response, pathname) {
  const target = pathname === "/"
    ? "/index.html"
    : pathname === "/debug"
      ? "/debug.html"
      : pathname;
  const filePath = path.join(publicDir, target);
  const ext = path.extname(filePath);
  let content;

  try {
    content = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return sendJson(response, 404, { ok: false, error: "Not found" });
    }
    throw error;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream"
  });
  response.end(content);
}

function sceneDescription(scene) {
  const map = {
    town_dialogue: "城镇对话",
    bag_management: "背包管理",
    market_trade: "交易/商店",
    jail_warning: "高风险警告",
    field_patrol: "野外巡游"
  };

  return map[scene] || "未判定场景";
}

function perceptionSummaryBySource(perception, source) {
  if (!perception) {
    return source === "agent"
      ? "当前自主实验还没有截图输入，先按文字目标和既有上下文推进。"
      : "当前还没有截图输入，本轮只基于文字/语音指令生成实验方案。";
  }

  return `已结合最新截图：${perception.sceneLabel || "未判定场景"}。${perception.summary || "暂无视觉总结。"}`
    .trim();
}

function buildWatchHistoryMessages(conversationMessages = [], rounds = 5) {
  const filtered = conversationMessages
    .filter((message) => message?.role === "user" || message?.role === "assistant");
  const selected = [];
  let assistantCount = 0;

  for (let index = filtered.length - 1; index >= 0; index -= 1) {
    const message = filtered[index];
    const content = String(message.text || "").trim();

    if (!content) {
      continue;
    }

    selected.unshift({
      role: message.role,
      content
    });

    if (message.role === "assistant") {
      assistantCount += 1;
      if (assistantCount >= rounds) {
        break;
      }
    }
  }

  return selected;
}

function buildLingshuGameplayContextLine(context = {}) {
  return `灵枢玩法资料：${LINGSHU_GAMEPLAY_CONTEXT}`;
}

async function buildWatchCommentary({ imageInput, conversationMessages = [] }) {
  const historyMessages = buildWatchHistoryMessages(conversationMessages, 5);
  const lingshuContextLine = buildLingshuGameplayContextLine({ interactionMode: "watch" });

  const prompt = [
    "你是籽小刀，现在在旁边看籽岷玩天刀。",
    "当前任务：看当前画面，补一句带态度的吐槽或看法。",
    "当前上下文：你和籽岷是熟人搭档，不是正经解说。",
    "输出要求：只说一句中文，控制在50到100字，不要带引号，不要下命令，不要提AI、截图、OCR。",
    "输出要求：语气要像熟人搭档，嘴碎一点，坏一点，但别像解说词。",
    "当前上下文：你现在就是在旁边陪看，顺手补一句带态度的接话。",
    lingshuContextLine
  ].join("\n");

  const result = await analyzeImageWithHistory({
    imageInput,
    historyMessages,
    prompt,
    systemPrompt: "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。",
    maxTokens: 80,
    temperature: 0.7
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function buildWatchUserReply({ instruction, imageInput, conversationMessages = [] }) {
  const historyMessages = buildWatchHistoryMessages(conversationMessages, 5);
  const lingshuContextLine = buildLingshuGameplayContextLine({
    interactionMode: "watch",
    instruction
  });

  const prompt = [
    "你是籽小刀，现在在旁边陪籽岷玩天刀。",
    "当前任务：籽岷刚刚对你说了一句话，你先顺着回他一句。",
    "当前上下文：你和籽岷是熟人搭档。",
    "输出要求：只说一句中文，控制在50到100字，不要带引号，不要提AI、截图、OCR。",
    "输出要求：语气要像熟人搭档，聪明、嘴碎、略带坏心眼，但别进入任务规划。",
    lingshuContextLine,
    `籽岷刚刚说：${instruction}`
  ].join("\n");

  const result = await analyzeImageWithHistory({
    imageInput,
    historyMessages,
    prompt,
    systemPrompt: "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。",
    maxTokens: 140,
    temperature: 0.65
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function maybeRunWatchCommentaryTurn(runtimeState) {
  const perception = runtimeState.latestPerception;
  const imageInput = latestCaptureImageDataUrl;

  if (!perception || !imageInput) {
    return false;
  }

  const now = Date.now();
  const lastCommentaryAt = runtimeState.agent?.lastWatchCommentaryAt
    ? new Date(runtimeState.agent.lastWatchCommentaryAt).getTime()
    : 0;
  const cooldownUntil = runtimeState.agent?.watchCommentaryCooldownUntil
    ? new Date(runtimeState.agent.watchCommentaryCooldownUntil).getTime()
    : 0;

  if (cooldownUntil && now < cooldownUntil) {
    return false;
  }

  if (lastCommentaryAt && now - lastCommentaryAt < WATCH_COMMENTARY_MIN_INTERVAL_MS) {
    return false;
  }

  const text = await buildWatchCommentary({
    imageInput,
    conversationMessages: runtimeState.messages
  });

  if (!text) {
    return false;
  }

  appendMessage({
    role: "assistant",
    text,
    thinkingChain: [],
    perceptionSummary: perceptionSummaryBySource(perception, "agent"),
    sceneLabel: perception.sceneLabel || "观看模式",
    riskLevel: perception.alerts?.length ? "medium" : "low",
    actions: [],
    decide: ""
  });

  appendLog("info", "观看模式自动旁白已发送", {
    text,
    trigger: "scheduled_commentary",
    sceneLabel: perception.sceneLabel || "",
    alerts: perception.alerts || []
  });

  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: "watch",
    lastTurnSource: "agent",
    lastTurnAt: new Date().toISOString(),
    lastAutonomousInstruction: "watch_commentary",
    lastWatchCommentaryAt: new Date().toISOString(),
    watchCommentaryCooldownUntil: null,
    autonomousTurnCount: (runtimeState.agent?.autonomousTurnCount || 0) + 1
  });

  return true;
}

async function runWatchUserReplyTurn({ instruction, scene, perception, conversationMessages = [] }) {
  if (!latestCaptureImageDataUrl) {
    appendMessage({
      role: "assistant",
      text: "你先继续玩，我盯到画面再接你这句。",
      thinkingChain: [],
      perceptionSummary: perceptionSummaryBySource(perception, "agent"),
      sceneLabel: perception?.sceneLabel || sceneDescription(scene),
      riskLevel: "low",
      actions: [],
      decide: ""
    });
    updateAgent({
      mode: "user_priority",
      phase: "cooldown",
      currentObjective: "watch",
      queuedUserObjective: null,
      lastUserInstruction: instruction,
      lastTurnSource: "user",
      lastTurnAt: new Date().toISOString(),
      watchCommentaryCooldownUntil: new Date(Date.now() + WATCH_USER_REPLY_COOLDOWN_MS).toISOString()
    });
    return;
  }

  await waitForTurnSlot();

  updateAgent({
    mode: "user_priority",
    phase: "user_priority",
    currentObjective: instruction,
    queuedUserObjective: instruction
  });

  try {
    const replyText = await buildWatchUserReply({
      instruction,
      imageInput: latestCaptureImageDataUrl,
      conversationMessages
    });

    if (!replyText) {
      throw new Error("观看模式没有生成可用回复。");
    }

    appendMessage({
      role: "assistant",
      text: replyText,
      thinkingChain: [],
      perceptionSummary: perceptionSummaryBySource(perception, "agent"),
      sceneLabel: perception?.sceneLabel || sceneDescription(scene),
      riskLevel: perception?.alerts?.length ? "medium" : "low",
      actions: [],
      decide: ""
    });

    appendLog("info", "观看模式已优先回复籽岷", {
      instruction,
      replyText
    });

    updateAgent({
      mode: "user_priority",
      phase: "cooldown",
      currentObjective: "watch",
      queuedUserObjective: null,
      lastUserInstruction: instruction,
      lastTurnSource: "user",
      lastTurnAt: new Date().toISOString(),
      watchCommentaryCooldownUntil: new Date(Date.now() + WATCH_USER_REPLY_COOLDOWN_MS).toISOString()
    });
  } finally {
    turnInFlight = false;
  }
}

function ensureAutoCaptureRunning() {
  const captureState = getState().capture;

  if (voiceAutoCaptureHoldActive) {
    return;
  }

  if (!captureState.enabled || captureState.status === "idle" || captureState.status === "paused") {
    autoCaptureService.start();
  }
}

function syncAutoCaptureForInteractionMode(interactionMode) {
  if (voiceAutoCaptureHoldActive) {
    autoCaptureService.pause();
    return;
  }

  if (interactionMode === "watch") {
    ensureAutoCaptureRunning();
    return;
  }

  autoCaptureService.stop();
}

function buildAssistantMessage({ plan, execution, perceptionSummary }) {
  return {
    role: "assistant",
    text: `籽小刀判断：${plan.personaInterpretation}。我先按“${plan.selectedStrategy}”推进。${execution.outcome}`,
    intentSummary: plan.intent,
    personaInterpretation: plan.personaInterpretation,
    thinkingChain: plan.thinkingChain,
    recoveryLine: plan.recoveryLine,
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: execution.steps,
    decide: plan.decide
  };
}

function buildUserMessage({ instruction, scene, perception, origin = "user" }) {
  return {
    role: "user",
    text: instruction,
    scene,
    perception,
    origin
  };
}

function buildExperimentRecord({
  instruction,
  source,
  scene,
  plan,
  execution,
  perception,
  perceptionSummary
}) {
  return {
    title: `${source === "agent" ? "自主实验" : "主播实验"}：${instruction}`,
    source,
    scene,
    instruction,
    intent: plan.intent,
    personaInterpretation: plan.personaInterpretation,
    selectedStrategy: plan.selectedStrategy,
    candidateStrategies: plan.candidateStrategies,
    riskLevel: plan.riskLevel,
    thinkingChain: plan.thinkingChain,
    recoveryLine: plan.recoveryLine,
    actions: execution.steps,
    perception: perception || null,
    perceptionSummary,
    outcome: execution.outcome
  };
}

function hasNpcConversationHistory(conversationRounds = []) {
  return Array.isArray(conversationRounds) && conversationRounds.length > 0;
}

function buildNpcReplyStylePrompt(plan, hasHistory = false, currentRoundNumber = 1) {
  if (plan?.scriptKey === "social_warm") {
    if (!hasHistory) {
      return [
        "这是第一轮开场。第一句固定说：你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？",
        "从第二句开始，每轮换一个角度夸籽岷，不要连续两轮用同一个卖点。",
        "只许使用允许的事实池，不要自己编新身份、新经历、新头衔。",
        "禁止提到“灵枢绘世专栏”“常驻”“专栏”这类不在事实池里的说法。"
      ].join("");
    }
    return [
      "你的回复要持续吹籽岷，目标是让NPC牢牢记住籽岷；对方烦了也没关系，可以继续缠着说。",
      "每轮换一个角度夸，例如名气、粉丝、百大UP主、创始人、人脉和影响力，不要连续两轮重复同一卖点。",
      "只许使用允许的事实池，不要编造事实。",
      "禁止提到“灵枢绘世专栏”“常驻”“专栏”这类错误说法。"
    ].join("");
  }

  if (plan?.scriptKey === "social_dark") {
    if (currentRoundNumber <= 4) {
      return "先像正常聊天那样请教怎么搞钱，别一上来就太黑；语气像在认真请教，但可以稍微透出一点急着赚钱的焦躁。";
    }
    return "你的回复要先正常追问赚钱门路，再逐渐黑化，允许直接问闷棍、妙取能不能赚钱，也可以讥讽对方别装不懂，但不要把话直接聊死。";
  }

  if (!hasHistory) {
    return "这是空态首轮。你的回复要先像普通聊天那样把话接住，语气自然一点，像真人顺着对方的话往下聊，不要突然带任务，不要硬转搞钱。";
  }

  return "你的回复要像真人闲聊一样顺着接话，轻一点、活一点，不要突然带任务，不要把话题硬拐去搞钱或套情报。";
}

function buildNpcConversationGoal({ instruction, plan, hasHistory = false, currentRoundNumber = 1 }) {
  if (plan?.scriptKey === "social_warm") {
    if (!hasHistory) {
      return [
        "这轮目标是吹籽岷，让NPC一定记住籽岷。",
        "第一句固定说：你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？",
        "从第二句起，围绕下面这些资料自然发挥，不要逐条背资料，而是像真人炫耀。",
        "每轮换一个角度夸，连续两轮不能重复同一个卖点。",
        "只许使用下面的允许事实池，不要编造。",
        ZIMIN_ALLOWED_FACT_POOL,
        "禁止使用“灵枢绘世专栏”“常驻”“专栏”等不在事实池的说法。"
      ].join("\n");
    }
    return [
      "继续围绕籽岷聊下去，目标不是套情报，而是让对方牢牢记住籽岷。",
      "可以持续吹籽岷的身份、名气、粉丝量、百大UP主、创始人和人脉影响力。",
      "每轮换一个角度夸，连续两轮不能重复同一个卖点。",
      "只许使用下面的允许事实池，不要编造。",
      ZIMIN_ALLOWED_FACT_POOL,
      "禁止使用“灵枢绘世专栏”“常驻”“专栏”等不在事实池的说法。",
      "就算NPC开始不耐烦，也不要轻易收口。"
    ].join("\n");
  }

  if (plan?.scriptKey === "social_dark") {
    if (currentRoundNumber <= 4) {
      return "先正常请教搞钱的门路，问对方有没有来钱快一点的办法，别一上来就把话题聊成纯犯罪咨询。";
    }
    return "继续聊怎么搞钱，先正常后黑化，开始直接问闷棍、妙取能不能赚钱，也要追问人、货、地点、时机这些细节。";
  }

  return "顺着当前 NPC 的话自然接下去，像真人聊天一样把话接住，不要默认带任务目标，不要主动把话题拐到搞钱、套话或固定剧本上。";
}

function parseJsonObjectFromLlmText(rawText) {
  const text = String(rawText || "").trim();

  if (!text) {
    throw new Error("LLM returned empty text");
  }

  const candidates = [
    text,
    text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "")
  ];

  const firstBraceIndex = text.indexOf("{");
  const lastBraceIndex = text.lastIndexOf("}");
  if (firstBraceIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
    candidates.push(text.slice(firstBraceIndex, lastBraceIndex + 1));
  }

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized) {
      continue;
    }
    try {
      return JSON.parse(normalized);
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to parse JSON from LLM text: ${text}`);
}

async function analyzeNpcChatRound({
  instruction,
  plan = null,
  conversationRounds = []
}) {
  const capture = await captureGameWindow();
  latestCaptureImageDataUrl = capture.imageDataUrl;

  const hasHistory = hasNpcConversationHistory(conversationRounds);
  const currentRoundNumber = conversationRounds.length + 1;
  const conversationGoal = buildNpcConversationGoal({
    instruction,
    plan,
    hasHistory,
    currentRoundNumber
  });
  const socialWarmFactPoolLine = plan?.scriptKey === "social_warm"
    ? `允许事实池：\n${ZIMIN_ALLOWED_FACT_POOL}\n禁止输出“灵枢绘世专栏”“常驻”“专栏”这类不在事实池的内容。`
    : "";
  const lingshuContextLine = buildLingshuGameplayContextLine({
    scriptKey: plan?.scriptKey || "",
    instruction
  });
  const prompt = [
    "你是籽小刀，要根据当前画面判断是否还在和NPC聊天。",
    "当前任务：如果已经不是聊天状态，返回 not_chat；如果还是聊天状态，先读出NPC刚说的话，再替籽小刀回一句。",
    `当前聊天目标：${conversationGoal}`,
    lingshuContextLine,
    socialWarmFactPoolLine,
    "特别规则：只要画面里还能看到“点击输入聊天”和“发送”，就还是可继续聊天的 chat_ready，不能因为“此次对话已完结”这句话就返回 not_chat。",
    "特别规则：对话上下文以当前截图为准，不要依赖额外文字版历史对话。",
    `当前上下文：${buildNpcReplyStylePrompt(plan, hasHistory, currentRoundNumber)}`,
    "输出要求：如果看不出当前还在聊什么，就保守返回 not_chat，不要编造。",
    "输出要求：replyText 只用中文一句话，8到24字，像真人接话，不要提系统、截图、OCR、AI、模型、好感度数值。",
    "输出要求：严格只输出 JSON，不要带代码块，不要加解释。",
    "格式：{\"screenState\":\"chat_ready|not_chat\",\"npcLine\":\"...\",\"replyText\":\"...\"}"
  ].join("\n");

  const result = await analyzeImageWithHistory({
    imageInput: capture.imageDataUrl,
    prompt,
    systemPrompt: "你是籽小刀的 NPC 聊天视觉助手。你只能根据当前游戏截图做保守判断，并且只能输出严格 JSON。",
    maxTokens: 180,
    temperature: 0.2
  });

  const payload = parseJsonObjectFromLlmText(result.text);
  const screenState = payload?.screenState === "chat_ready" ? "chat_ready" : "not_chat";
  const dialogText = String(payload?.npcLine || "").replace(/\s+/g, " ").trim();
  const replyText = String(payload?.replyText || "").replace(/\s+/g, " ").trim();

  return {
    screenState,
    dialogText,
    replyText,
    imageInput: capture.imageDataUrl,
    capturedAt: capture.capturedAt,
    rawText: String(result.text || "")
  };
}

async function sendNpcChatReply({ replyText, externalInputGuardEnabled = true, closeAfterSend = false }) {
  return runWindowsActions([
    {
      id: "reply-1",
      title: "发送闲聊回复",
      sourceType: "talk_reply",
      type: "send_chat_message",
      text: replyText,
      closeAfterSend,
      closeSettleMs: closeAfterSend ? 700 : 0,
      postDelayMs: 300
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });
}

async function closeCurrentNpcChatPanel({ externalInputGuardEnabled = true }) {
  return runWindowsActions([
    {
      id: "reply-close-1",
      title: "关闭当前聊天页",
      sourceType: "talk_reply",
      type: "close_current_panel",
      postDelayMs: 300
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });
}

async function waitForNpcFollowupAfterSend({
  instruction,
  plan,
  conversationRounds,
  previousDialogText = ""
}) {
  const probe = await waitForActionableNpcRoundState({
    instruction,
    plan,
    conversationRounds,
    previousDialogText
  });
  const roundState = probe.roundState || {};

  if (probe.status === "chat_closed" || roundState.screenState !== "chat_ready") {
    return {
      status: "chat_closed",
      roundState
    };
  }

  const dialogText = String(roundState.dialogText || "").trim();
  const normalizedPreviousDialog = String(previousDialogText || "").trim();
  const hasFreshNpcReply = Boolean(dialogText)
    && !isTransientNpcDialogText(dialogText)
    && (!normalizedPreviousDialog || dialogText !== normalizedPreviousDialog);

  return {
    status: hasFreshNpcReply ? "reply_observed" : "reply_missing",
    roundState: {
      ...roundState,
      dialogText
    }
  };
}

function mergeExecutions(executions, fallbackOutcome) {
  const valid = executions.filter(Boolean);

  if (valid.length === 0) {
    return {
      executor: "NpcChatLoop",
      steps: [],
      rawSteps: [],
      durationMs: 0,
      outcome: fallbackOutcome
    };
  }

  return {
    executor: "NpcChatLoop",
    steps: valid.flatMap((item) => item.steps || []),
    rawSteps: valid.flatMap((item) => item.rawSteps || []),
    durationMs: valid.reduce((sum, item) => sum + (item.durationMs || 0), 0),
    outcome: fallbackOutcome
  };
}

async function runNpcConversationLoop({
  instruction,
  plan = null,
  externalInputGuardEnabled = true,
  maxRounds = NPC_CHAT_MAX_ROUNDS,
  closeAfterSend = false,
  onBeforeRound = null
}) {
  const rounds = [];
  const executions = [];
  let currentDialogText = "";
  let stopReason = "dialog_exhausted";

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex += 1) {
    const previousDialogText = String(rounds[rounds.length - 1]?.dialogText || "").trim();
    const roundProbe = await waitForActionableNpcRoundState({
      instruction,
      plan,
      conversationRounds: rounds,
      previousDialogText
    });
    const roundState = roundProbe.roundState;

    if (roundProbe.status === "chat_closed" || roundState.screenState !== "chat_ready") {
      stopReason = roundIndex === 0 ? "chat_not_ready" : "dialog_closed";
      break;
    }

    currentDialogText = String(roundState.dialogText || "").trim();

    if (typeof onBeforeRound === "function") {
      await onBeforeRound({
        roundNumber: roundIndex + 1,
        dialogText: currentDialogText,
        rounds
      });
    }

    const replyText = plan?.scriptKey === "social_warm" && roundIndex === 0
      ? "你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？"
      : String(roundState.replyText || "").trim();

    if (!replyText) {
      stopReason = "reply_missing";
      break;
    }

    const isLastRound = roundIndex === maxRounds - 1;
    const replyExecution = await sendNpcChatReply({
      replyText,
      externalInputGuardEnabled,
      closeAfterSend: false
    });
    executions.push(replyExecution);

    rounds.push({
      round: roundIndex + 1,
      dialogText: currentDialogText,
      replyText
    });

    appendLog("info", `NPC 多轮对话第 ${roundIndex + 1} 轮已发送`, {
      dialogText: currentDialogText,
      replyText
    });

    if (isLastRound) {
      if (closeAfterSend) {
        const followupProbe = await waitForNpcFollowupAfterSend({
          instruction,
          plan,
          conversationRounds: rounds,
          previousDialogText: currentDialogText
        });

        if (followupProbe.status !== "reply_observed") {
          stopReason = followupProbe.status === "chat_closed"
            ? "dialog_closed"
            : "final_dialog_missing";
          currentDialogText = String(followupProbe.roundState?.dialogText || currentDialogText || "").trim();
          break;
        }

        currentDialogText = String(followupProbe.roundState?.dialogText || currentDialogText || "").trim();
        appendLog("info", "NPC 已回复最终一轮对话，准备关闭聊天页", {
          dialogText: currentDialogText
        });
        const closeExecution = await closeCurrentNpcChatPanel({
          externalInputGuardEnabled
        });
        executions.push(closeExecution);
      }

      stopReason = "max_rounds_reached";
      break;
    }

    await sleep(NPC_CHAT_POLL_DELAY_MS);
  }

  const execution = mergeExecutions(
    executions,
    rounds.length > 0
      ? `已完成 ${rounds.length} 轮 NPC 对话。`
      : "未能生成可发送的 NPC 对话回复。"
  );

  return {
    rounds,
    execution,
    stopReason,
    finalDialogText: currentDialogText
  };
}

async function maybeReplyFromCurrentChatScreen({
  instruction,
  plan = null,
  perceptionSummary = "",
  externalInputGuardEnabled = true,
  maxRounds = NPC_CHAT_MAX_ROUNDS,
  closeAfterSend = false
}) {
  const loopResult = await runNpcConversationLoop({
    instruction,
    plan,
    externalInputGuardEnabled,
    maxRounds,
    closeAfterSend,
    onBeforeRound: ({ roundNumber }) => {
      if (!plan?.scriptKey) {
        return null;
      }
      const text = getFixedReplyLoopCommentary(plan.scriptKey, plan.scriptRoundNumber, roundNumber);
      appendFixedScriptCommentary({
        text,
        plan,
        perceptionSummary
      });
      return null;
    }
  });

  if (!loopResult.rounds.length) {
    return null;
  }

  appendLog("info", "当前聊天页多轮对话已执行", {
    rounds: loopResult.rounds.length,
    stopReason: loopResult.stopReason
  });

  return {
    dialogText: loopResult.rounds[0]?.dialogText || "",
    replyText: loopResult.rounds[loopResult.rounds.length - 1]?.replyText || "",
    rounds: loopResult.rounds,
    probeExecution: null,
    execution: loopResult.execution,
    stopReason: loopResult.stopReason
  };
}

async function runChatAssistTurn(runtimeState) {
  const automation = runtimeState.automation || {};
  const instruction = String(automation.instruction || "帮我聊吧").trim() || "帮我聊吧";
  const conversationRounds = Array.isArray(automation.chatAssistRounds)
    ? automation.chatAssistRounds
    : [];

  const roundState = await analyzeNpcChatRound({
    instruction,
    conversationRounds
  });

  if (roundState.screenState !== "chat_ready") {
    return false;
  }

  const dialogText = String(roundState.dialogText || "").trim();
  const replyText = String(roundState.replyText || "").trim();
  const lastDialogText = String(automation.chatAssistLastDialogText || "").trim();

  if (!dialogText || !replyText || dialogText === lastDialogText) {
    return false;
  }

  const replyExecution = await sendNpcChatReply({
    replyText,
    externalInputGuardEnabled: true,
    closeAfterSend: false
  });

  const nextRounds = [
    ...conversationRounds,
    {
      round: conversationRounds.length + 1,
      dialogText,
      replyText
    }
  ].slice(-6);

  updateAutomation({
    status: "chat_assist",
    mode: "chat_assist",
    totalTurns: (automation.totalTurns || 0) + 1,
    chatAssistLastDialogText: dialogText,
    chatAssistRounds: nextRounds,
    lastOutcome: `已代聊 ${nextRounds.length} 轮`
  });

  appendMessage({
    role: "assistant",
    text: replyText,
    thinkingChain: [],
    perceptionSummary: perceptionSummaryBySource(getState().latestPerception, "agent"),
    sceneLabel: getState().latestPerception?.sceneLabel || "当前聊天页",
    riskLevel: "low",
    actions: [],
    decide: ""
  });

  appendLog("info", "帮聊模式已发送一轮聊天回复", {
    dialogText,
    replyText
  });

  return {
    replyExecution,
    dialogText,
    replyText
  };
}

async function maybeSendNpcReply({
  instruction,
  plan,
  execution,
  perceptionSummary = "",
  externalInputGuardEnabled = true,
  closeAfterSend = false
}) {
  const finalTalkStep = [...(execution.rawSteps || [])]
    .reverse()
    .find((step) => step?.input?.stage === "chat_ready");
  const talkStage = String(finalTalkStep?.input?.stage || "").trim();

  if (talkStage !== "chat_ready") {
    return null;
  }

  const loopResult = await runNpcConversationLoop({
    instruction,
    plan,
    externalInputGuardEnabled,
    closeAfterSend,
    onBeforeRound: ({ roundNumber }) => {
      if (!plan?.scriptKey) {
        return null;
      }
      const text = getFixedReplyLoopCommentary(plan.scriptKey, plan.scriptRoundNumber, roundNumber);
      appendFixedScriptCommentary({
        text,
        plan,
        perceptionSummary
      });
      return null;
    }
  });

  if (!loopResult.rounds.length) {
    return null;
  }

  appendLog("info", "NPC 多轮对话已执行", {
    rounds: loopResult.rounds.length,
    stopReason: loopResult.stopReason
  });

  return {
    replyText: loopResult.rounds[loopResult.rounds.length - 1]?.replyText || "",
    rounds: loopResult.rounds,
    execution: loopResult.execution,
    stopReason: loopResult.stopReason
  };
}

function mergeFixedExecutionWithReplyResult(execution, replyResult) {
  if (!replyResult) {
    return execution;
  }

  return {
    ...execution,
    steps: [
      ...execution.steps,
      ...replyResult.execution.steps
    ],
    rawSteps: [
      ...execution.rawSteps,
      ...replyResult.execution.rawSteps
    ],
    durationMs: execution.durationMs + replyResult.execution.durationMs,
    outcome: execution.outcome,
    replyText: replyResult.replyText,
    replyRounds: replyResult.rounds
  };
}

async function runFixedActionChunk({
  actions,
  options,
  plan,
  perceptionSummary,
  commentaryText,
  executions,
  emitCommentary = true,
  segmentId = null
}) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return null;
  }

  if (segmentId) {
    updateAutomation({
      currentSegmentId: segmentId
    });
  }

  if (emitCommentary) {
    await appendFixedScriptCommentaryWithPause({
      text: commentaryText,
      plan,
      perceptionSummary
    });
  }

  const execution = await runWindowsActions(actions, options);
  executions.push(execution);
  return execution;
}

function commitFixedScriptTurnExecution({
  scene,
  perception,
  interactionMode,
  externalInputGuardEnabled,
  perceptionSummary,
  plan,
  execution,
  resultText
}) {
  const turn = {
    id: `turn-${Date.now()}`,
    instruction: "按刚才那套安排继续推进",
    scene,
    createdAt: new Date().toISOString(),
    source: "agent",
    interactionMode,
    externalInputGuardEnabled,
    plan,
    execution,
    perception: perception || null
  };

  setCurrentTurn(turn);

  appendMessage({
    role: "assistant",
    text: resultText,
    thinkingChain: [],
    recoveryLine: plan.recoveryLine,
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: execution.steps,
    decide: ""
  });

  appendExperiment(buildExperimentRecord({
    instruction: "按既定安排继续推进",
    source: "agent",
    scene,
    plan,
    execution,
    perception,
    perceptionSummary
  }));

  updateAutomation({
    lastOutcome: execution.outcome
  });
  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: "按既定安排继续往下做",
    queuedUserObjective: null,
    lastTurnSource: "agent",
    lastTurnAt: new Date().toISOString(),
    autonomousTurnCount: (getState().agent?.autonomousTurnCount || 0) + 1
  });
}

function getStealthStageRoundOutcome(stageKey, execution) {
  const key = String(stageKey || "").trim();
  if (!["dark_close", "dark_miaoqu"].includes(key)) {
    return null;
  }
  const outcomeKind = String(execution?.outcomeKind || "completed").trim();
  if (key === "dark_close") {
    return outcomeKind === "completed" ? "success" : "failure";
  }
  if (key === "dark_miaoqu") {
    return outcomeKind === "completed" ? "success" : "failure";
  }
  return null;
}

function recordStealthStageRoundOutcome(stageKey, execution) {
  const outcome = getStealthStageRoundOutcome(stageKey, execution);
  if (!outcome) {
    return;
  }
  const automation = getState().automation || {};
  const currentTallies = automation.stealthStageTallies || {};
  const stageTallies = currentTallies[stageKey] || { success: 0, failure: 0 };
  updateAutomation({
    stealthStageTallies: {
      ...currentTallies,
      [stageKey]: {
        success: Number(stageTallies.success || 0) + (outcome === "success" ? 1 : 0),
        failure: Number(stageTallies.failure || 0) + (outcome === "failure" ? 1 : 0)
      }
    }
  });
}

async function recordInteractionLearningSample({
  instruction,
  source,
  scene,
  plan,
  perception,
  execution,
  error = null
}) {
  if (!isInteractionPlan(plan)) {
    return;
  }

  try {
    const sample = buildInteractionSample({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution,
      error
    });
    await appendInteractionSample(sample);
    appendLog("info", "NPC 交互样本已写入本地学习记录", {
      sampleId: sample.id,
      success: sample.success,
      result: sample.result
    });
  } catch (recordError) {
    appendLog("error", "NPC 交互样本写入失败", {
      error: recordError.message
    });
  }
}

async function recordMotionReviewSamples({
  instruction,
  source,
  scene,
  plan,
  perception,
  execution,
  error = null
}) {
  try {
    const samples = buildMotionReviewSamples({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution,
      error
    });

    if (samples.length === 0) {
      return;
    }

    const persisted = await appendMotionReviewSamples(samples);
    appendLog("info", "动作边界样本已写入待复核队列", {
      sampleIds: persisted.map((sample) => sample.id),
      sampleCount: persisted.length
    });

    triggerMotionReviewPass().then((results) => {
      if (results.length === 0) {
        return;
      }
      appendLog("info", "本地模型已完成动作边界样本复核", {
        reviewCount: results.length,
        sampleIds: results.map((item) => item.sampleId)
      });
    }).catch((reviewError) => {
      appendLog("error", "动作边界样本复核失败", {
        error: reviewError.message
      });
    });
  } catch (recordError) {
    appendLog("error", "动作边界样本写入失败", {
      error: recordError.message
    });
  }
}

async function finalizeFixedScriptTurnExecution({
  stage,
  roundNumber,
  userInstruction,
  scene,
  perception,
  interactionMode,
  externalInputGuardEnabled,
  perceptionSummary,
  plan,
  execution,
  recoveryKind = null,
  replyResultOverride,
  skipExecutionRecording = false
}) {
  if (interactionMode !== "watch") {
    if (!skipExecutionRecording) {
      await recordMotionReviewSamples({
        instruction: plan.intent,
        source: "agent",
        scene,
        plan,
        perception,
        execution
      });

      await recordInteractionLearningSample({
        instruction: plan.intent,
        source: "agent",
        scene,
        plan,
        perception,
        execution
      });
    }

    let replyResult = replyResultOverride;
    if (replyResult === undefined) {
      try {
        replyResult = await maybeSendNpcReply({
          instruction: plan.intent,
          plan,
          execution,
          perceptionSummary,
          externalInputGuardEnabled,
          closeAfterSend: stage.key === "social_warm" || stage.key === "social_dark"
        });
      } catch (error) {
        error.resumeContext = buildNpcReplyResumeContext({
          stage,
          roundNumber,
          userInstruction,
          scene,
          perception,
          interactionMode,
          externalInputGuardEnabled,
          perceptionSummary,
          plan
        }, error, execution);
        throw error;
      }
    }

    execution = mergeFixedExecutionWithReplyResult(execution, replyResult);
  }

  execution = {
    ...execution,
    outcome: buildFixedStageResultText({
      stage,
      roundNumber,
      execution,
      recoveryKind
    })
  };

  commitFixedScriptTurnExecution({
    scene,
    perception,
    interactionMode,
    externalInputGuardEnabled,
    perceptionSummary,
    plan,
    execution,
    resultText: execution.outcome
  });

  appendLog("info", "固定剧本动作已执行", {
    scriptKey: stage.key,
    roundNumber,
    outcome: execution.outcome
  });
  recordStealthStageRoundOutcome(stage.key, execution);

  return {
    plan,
    execution
  };
}

function annotateFailureAttemptMetadata(error, patch = {}) {
  if (error?.workerPayload?.failedStep?.input && typeof error.workerPayload.failedStep.input === "object") {
    Object.assign(error.workerPayload.failedStep.input, patch);
  }
  return error;
}

async function runFixedSellLoopStageExecution({
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  const actions = createFixedSellLoopActions({ roundNumber });
  const executions = [];
  const options = {
    interruptOnExternalInput: externalInputGuardEnabled
  };
  updateAutomation({ currentSegmentId: "buy_phase" });

  await runFixedActionChunk({
    actions: actions.slice(0, 2),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary("sell_loop", roundNumber, "travel"),
    executions
  });
  await runFixedActionChunk({
    actions: actions.slice(2, 4),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary("sell_loop", roundNumber, "vendor"),
    executions
  });
  await runFixedActionChunk({
    actions: actions.slice(4, 5),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary("sell_loop", roundNumber, "buy"),
    executions
  });
  updateAutomation({ currentSegmentId: "hawking_phase" });
  await runFixedActionChunk({
    actions: actions.slice(5, 9),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary("sell_loop", roundNumber, "setup"),
    executions
  });
  await runFixedActionChunk({
    actions: actions.slice(9),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary("sell_loop", roundNumber, "hawk"),
    executions
  });

  const execution = mergeWorkerExecutions(executions);
  return {
    ...execution,
    outcomeKind: "completed"
  };
}

async function runFixedStreetWanderStageExecution({
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  const executions = [];
  const options = {
    interruptOnExternalInput: externalInputGuardEnabled
  };
  updateAutomation({ currentSegmentId: "wander" });
  const actions = createFixedStreetWanderActions();
  const movementCommentary = [
    ...(Array.isArray(plan.thinkingChain) ? plan.thinkingChain : []),
    getFixedStageProgressText("street_wander", roundNumber, "wander")
  ].filter(Boolean);

  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    const commentaryText = index < movementCommentary.length
      ? movementCommentary[index]
      : index === actions.length - 1
        ? getFixedStageProgressText("street_wander", roundNumber, "pause")
        : "";

    await runFixedActionChunk({
      actions: [action],
      options,
      plan,
      perceptionSummary,
      commentaryText,
      executions
    });
  }

  return {
    ...mergeWorkerExecutions(executions),
    outcomeKind: "completed"
  };
}

async function runFixedSocialGiftSequence({
  stage,
  roundNumber,
  plan,
  perceptionSummary,
  executions,
  options,
  entryIdPrefix,
  resolveIdPrefix,
  decisionAttempt = 1,
  emitCommentary = true
}) {
  const giftEntryExecution = await runFixedActionChunk({
    actions: createFixedSocialGiftEntryActions({ includeAcquire: false, idPrefix: entryIdPrefix }),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary(stage.key, roundNumber, "giftOpen"),
    executions,
    emitCommentary
  });
  const giftPolicy = getGiftPolicyFromExecution(giftEntryExecution) || "gift_fixed";
  const favorLimit = getGiftFavorLimitFromExecution(giftEntryExecution);
  if (emitCommentary) {
    await appendFixedScriptCommentaryWithPause({
      text: getSocialGiftDecisionCommentary(giftPolicy, favorLimit),
      plan,
      perceptionSummary
    });
  }
  const resolveExecution = await runWindowsActions(
    createFixedSocialGiftResolveActions({ idPrefix: resolveIdPrefix }),
    options
  );
  executions.push(resolveExecution);
  await appendGiftProgressCommentary({
    stage,
    plan,
    perceptionSummary,
    favorLimit,
    giftRounds: getGiftRoundsFromExecution(resolveExecution)
  });
  return {
    giftPolicy,
    favorLimit,
    execution: resolveExecution
  };
}

async function runFixedSocialStageExecution({
  stage,
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  const executions = [];
  const options = {
    interruptOnExternalInput: externalInputGuardEnabled
  };
  updateAutomation({ currentSegmentId: "stage_flow" });
  const approachActions = createFixedSocialApproachActions(stage.key);
  const talkActions = createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "fixed-social-talk" });

  await runFixedActionChunk({
    actions: approachActions.slice(0, 1),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary(stage.key, roundNumber, "travel"),
    executions
  });
  await runFixedActionChunk({
    actions: approachActions.slice(1),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary(stage.key, roundNumber, "arrive"),
    executions
  });
  await runFixedSocialGiftSequence({
    stage,
    roundNumber,
    plan,
    perceptionSummary,
    executions,
    options,
    entryIdPrefix: "fixed-social-gift-entry",
    resolveIdPrefix: "fixed-social-gift-resolve",
    decisionAttempt: 1
  });
  await runFixedActionChunk({
    actions: talkActions,
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary(stage.key, roundNumber, "talk"),
    executions
  });
  return {
    ...mergeWorkerExecutions(executions),
    outcomeKind: "completed"
  };
}

async function runFixedDarkCloseStageExecution({
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  const executions = [];
  const actions = createFixedDarkCloseStageActions({ roundNumber });
  const options = {
    interruptOnExternalInput: externalInputGuardEnabled
  };
  updateAutomation({ currentSegmentId: "round_flow" });
  const isRestartableDarkFailure = (error) => ["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(getFailureCode(error));
  const travelActionCount = roundNumber === 1 ? 1 : 0;
  const setupActionCount = roundNumber === 1 ? 1 : 0;
  const stealthStartIndex = travelActionCount + setupActionCount;
  const stealthEndIndex = stealthStartIndex + 3;
  const lootStartIndex = stealthEndIndex;
  const lootEndIndex = actions.length;

  try {
    if (travelActionCount > 0) {
      await runFixedActionChunk({
        actions: actions.slice(0, travelActionCount),
        options,
        plan,
        perceptionSummary,
        commentaryText: getFixedStageActionCommentary("dark_close", roundNumber, "travel"),
        executions
      });
    }
    if (setupActionCount > 0) {
      await runFixedActionChunk({
        actions: actions.slice(travelActionCount, stealthStartIndex),
        options,
        plan,
        perceptionSummary,
        commentaryText: getFixedStageActionCommentary("dark_close", roundNumber, "target"),
        executions
      });
    }
    await runFixedActionChunk({
      actions: actions.slice(stealthStartIndex, stealthEndIndex),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageActionCommentary("dark_close", roundNumber, "stealth"),
      executions
    });
    let lootFailure = null;
    try {
      await runFixedActionChunk({
        actions: actions.slice(lootStartIndex, lootEndIndex),
        options,
        plan,
        perceptionSummary,
        commentaryText: getFixedStageActionCommentary("dark_close", roundNumber, "loot"),
        executions
      });
    } catch (lootError) {
      lootFailure = lootError;
      appendFixedScriptCommentary({
        text: "搜刮这一下没扣实，我不回头复跑，直接切到下一段妙取，先把节奏接上。",
        plan,
        perceptionSummary
      });
    }

    const execution = mergeWorkerExecutions(executions);
    if (lootFailure) {
      const failedStep = lootFailure?.workerPayload?.failedStep || lootFailure?.failed_step || null;
      const failedSteps = Array.isArray(lootFailure?.workerPayload?.steps) ? lootFailure.workerPayload.steps : [];
      return {
        ...execution,
        steps: [...execution.steps, ...failedSteps, ...(failedStep ? [failedStep] : [])],
        rawSteps: [...execution.rawSteps, ...failedSteps],
        outcomeKind: "loot_skipped",
        lootFailureCode: getFailureCode(lootFailure),
        lootFailureStepTitle: failedStep?.title || "",
        lootFailureMessage: String(lootFailure?.message || ""),
      };
    }

    return {
      ...execution,
      outcomeKind: "completed"
    };
  } catch (initialError) {
    if (!isRestartableDarkFailure(initialError)) {
      throw initialError;
    }

    let lastError = initialError;
    for (let attemptIndex = 0; attemptIndex < DARK_CLOSE_RESTART_BUDGET; attemptIndex += 1) {
      try {
        executions.push(await runWindowsActions(createStealthEscapeRecoveryActions(), options));
        return {
          ...mergeWorkerExecutions(executions),
          outcomeKind: "recovered"
        };
      } catch (retryError) {
        if (!isRestartableDarkFailure(retryError)) {
          throw retryError;
        }
        lastError = retryError;
      }
    }

    throw annotateFailureAttemptMetadata(lastError, {
      attemptCount: DARK_CLOSE_RESTART_BUDGET,
      attemptBudget: DARK_CLOSE_RESTART_BUDGET
    });
  }
}

async function runFixedDarkMiaoquStageExecution({
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  const executions = [];
  const actions = createFixedDarkMiaoquStageActions();
  const options = {
    interruptOnExternalInput: externalInputGuardEnabled
  };
  updateAutomation({ currentSegmentId: "round_flow" });
  const isRestartableDarkFailure = (error) => ["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(getFailureCode(error));

  try {
    await runFixedActionChunk({
      actions: actions.slice(0, 1),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageActionCommentary("dark_miaoqu", roundNumber, "stealth"),
      executions
    });
    await runFixedActionChunk({
      actions: actions.slice(1, 2),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageActionCommentary("dark_miaoqu", roundNumber, "panel"),
      executions
    });
    await runFixedActionChunk({
      actions: actions.slice(2),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageActionCommentary("dark_miaoqu", roundNumber, "escape"),
      executions
    });
    return {
      ...mergeWorkerExecutions(executions),
      outcomeKind: "completed"
    };
  } catch (initialError) {
    if (!isRestartableDarkFailure(initialError)) {
      throw initialError;
    }

    let lastError = initialError;
    try {
      executions.push(await runWindowsActions(createFixedDarkMiaoquRecoveryActions(), options));
      return {
        ...mergeWorkerExecutions(executions),
        outcomeKind: "recovered"
      };
    } catch (retryError) {
      if (!isRestartableDarkFailure(retryError)) {
        throw retryError;
      }
      lastError = retryError;
    }

    throw annotateFailureAttemptMetadata(lastError, {
      attemptCount: 1,
      attemptBudget: 1
    });
  }
}

async function runFixedEndingTradeStageExecution({
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  const executions = [];
  const options = {
    interruptOnExternalInput: externalInputGuardEnabled
  };
  updateAutomation({ currentSegmentId: "stage_flow" });
  const relocatedOpenTradeActions = [
    ...createFixedEndingTradeRelocateActions({ idPrefix: "fixed-ending-trade-relocate" }),
    ...createFixedEndingTradeOpenTradeActions({
      idPrefix: "fixed-ending-trade-relocated",
      acquireTitle: "回到卦摊附近重新锁一个路人目标",
      menuTitle: "重新拉起路人交互菜单",
      tradeTitle: "重新打开交易页准备收尾卖货"
    })
  ];
  const tradeBundleActions = createFixedEndingTradeBundleActions({
    idPrefix: "fixed-ending-trade-bundle"
  });

  await appendFixedScriptCommentaryWithPause({
    text: getFixedStageActionCommentary("ending_trade", roundNumber, "target"),
    plan,
    perceptionSummary
  });
  const openTradeExecution = await runWindowsActions(relocatedOpenTradeActions, options);
  executions.push(openTradeExecution);

  await runFixedActionChunk({
    actions: tradeBundleActions.slice(0, 5),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary("ending_trade", roundNumber, "trade"),
    executions
  });
  await runFixedActionChunk({
    actions: tradeBundleActions.slice(5),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageActionCommentary("ending_trade", roundNumber, "finish"),
    executions
  });

  const execution = mergeWorkerExecutions(executions);
  return {
    ...execution,
    outcomeKind: "completed"
  };
}

async function runFixedStageExecution({
  stage,
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  switch (stage.key) {
    case "street_wander":
      return runFixedStreetWanderStageExecution({ roundNumber, plan, perceptionSummary, externalInputGuardEnabled });
    case "sell_loop":
      return runFixedSellLoopStageExecution({ roundNumber, plan, perceptionSummary, externalInputGuardEnabled });
    case "social_warm":
    case "social_dark":
      return runFixedSocialStageExecution({ stage, roundNumber, plan, perceptionSummary, externalInputGuardEnabled });
    case "dark_close":
      return runFixedDarkCloseStageExecution({ roundNumber, plan, perceptionSummary, externalInputGuardEnabled });
    case "dark_miaoqu":
      return runFixedDarkMiaoquStageExecution({ roundNumber, plan, perceptionSummary, externalInputGuardEnabled });
    case "ending_trade":
      return runFixedEndingTradeStageExecution({ roundNumber, plan, perceptionSummary, externalInputGuardEnabled });
    default:
      return runWindowsActions(buildStageWorkerActions(stage.key), {
        interruptOnExternalInput: externalInputGuardEnabled
      });
  }
}

async function runFixedScriptTurn({
  stage,
  roundNumber,
  userInstruction,
  scene,
  perception,
  interactionMode = "act",
  externalInputGuardEnabled = true
}) {
  const plan = buildFixedScriptPlan({
    stage,
    roundNumber,
    scene,
    userInstruction
  });
  const perceptionSummary = perceptionSummaryBySource(perception, "agent");

  appendMessage({
    role: "assistant",
    text: plan.personaInterpretation,
    thinkingChain: buildFixedScriptOpeningThinkingChain(stage.key, plan.thinkingChain),
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: [],
    decide: plan.decide
  });
  appendLog("info", "固定剧本思考已输出", {
    scriptKey: stage.key,
    roundNumber,
    selectedStrategy: plan.selectedStrategy
  });

  updateAutomation({
    lastThought: plan.decide
  });
  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: "按既定安排继续往下做",
    lastAutonomousInstruction: plan.intent
  });

  let execution;
  if (interactionMode === "watch") {
    execution = {
      executor: "WatchMode",
      steps: [],
      rawSteps: [],
      durationMs: 0,
      outcome: "当前处于观看模式，本轮只展示思考，不执行实际动作。"
    };
  } else {
    try {
      execution = await runFixedStageExecution({
        stage,
        roundNumber,
        plan,
        perceptionSummary,
        externalInputGuardEnabled
      });
    } catch (error) {
      const failedExecution = {
        rawSteps: Array.isArray(error.workerPayload?.steps) ? error.workerPayload.steps : [],
        durationMs: error.durationMs || null
      };

      await recordMotionReviewSamples({
        instruction: plan.intent,
        source: "agent",
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });

      await recordInteractionLearningSample({
        instruction: plan.intent,
        source: "agent",
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });
      error.resumeContext = buildResumeContextFromError({
        stage,
        roundNumber,
        userInstruction,
        scene,
        perception,
        interactionMode,
        externalInputGuardEnabled,
        perceptionSummary,
        plan
      }, error);
      throw error;
    }
  }
  return finalizeFixedScriptTurnExecution({
    stage,
    roundNumber,
    userInstruction,
    scene,
    perception,
    interactionMode,
    externalInputGuardEnabled,
    perceptionSummary,
    plan,
    execution,
    recoveryKind: null
  });
}

function recordAutonomousFailure(error) {
  const resumeContext = error?.resumeContext || null;
  updateAutomation({
    lastFailureCode: getFailureCode(error),
    lastRecoveryKind: resumeContext?.recoveryKind || null,
    lastRecoveryAttemptCount: resumeContext?.attemptCount || 0
  });

  if (resumeContext) {
    setPendingResumeContext({
      ...resumeContext,
      failureMessageId: null
    });
  } else {
    clearPendingResumeContext({ preserveFailureMeta: true });
  }
}

async function resumeFailedAutomationStep() {
  const context = pendingResumeContext;
  if (!context?.stage?.key && context?.recoveryKind !== "npc_reply_loop") {
    throw new Error("当前没有可继续的失败步骤。");
  }

  await waitForTurnSlot();
  clearPendingResumeContext();
  if (context.failureMessageId) {
    removeMessage(context.failureMessageId);
  }

  setLastError(null);
  setStatus("running");
  autoCaptureService.stop();
  updateAutomation({
    status: "running"
  });
  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: `从「${context.failedStepTitle || "失败步骤"}」继续`,
    lastAutonomousInstruction: context.plan?.intent || getState().agent.lastAutonomousInstruction
  });

  try {
    const latestPerception = getState().latestPerception || context.perception || null;
    const perceptionSummary = perceptionSummaryBySource(latestPerception, "agent");
    const resolvedRecovery = await resolveRecoveryExecutionPlan(context);
    const effectiveRecoveryKind = resolvedRecovery.recoveryKind;
    const effectiveWorkerActions = resolvedRecovery.workerActions || [];

    updateAutomation({
      lastRecoveryKind: `${effectiveRecoveryKind}:${resolvedRecovery.anchorState?.anchorId || "unknown"}`,
      lastRecoveryAttemptCount: resolvedRecovery.convergenceAttemptCount || 0
    });
    appendLog("info", "恢复锚点已收敛", {
      stageKey: context.stage?.key || null,
      roundNumber: context.roundNumber || null,
      anchorId: resolvedRecovery.anchorState?.anchorId || "unknown",
      confidence: resolvedRecovery.anchorState?.confidence || "unknown",
      recoveryKind: effectiveRecoveryKind,
      convergenceAttemptCount: resolvedRecovery.convergenceAttemptCount || 0
    });

    if (effectiveRecoveryKind === "npc_reply_loop") {
      let replyResult;
      try {
        replyResult = await maybeReplyFromCurrentChatScreen({
          instruction: context.userInstruction || context.plan?.intent || "",
          plan: context.plan,
          perceptionSummary,
          externalInputGuardEnabled: context.externalInputGuardEnabled
        });
      } catch (error) {
        error.resumeContext = buildNpcReplyResumeContext({
          stage: context.stage,
          roundNumber: context.roundNumber,
          userInstruction: context.userInstruction,
          scene: context.scene,
          perception: latestPerception,
          interactionMode: context.interactionMode,
          externalInputGuardEnabled: context.externalInputGuardEnabled,
          perceptionSummary,
          plan: context.plan
        }, error, context.baseExecution || {
          executor: "WindowsInputExecutor",
          steps: [],
          rawSteps: [],
          durationMs: 0,
          outcome: "这一轮主动作已经完成。"
        });
        throw error;
      }

      await finalizeFixedScriptTurnExecution({
        stage: context.stage,
        roundNumber: context.roundNumber,
        userInstruction: context.userInstruction,
        scene: context.scene,
        perception: latestPerception,
        interactionMode: context.interactionMode,
        externalInputGuardEnabled: context.externalInputGuardEnabled,
        perceptionSummary,
        plan: context.plan,
        execution: context.baseExecution || {
          executor: "WindowsInputExecutor",
          steps: [],
          rawSteps: [],
          durationMs: 0,
          outcome: "这一轮主动作已经完成。",
          outcomeKind: "completed"
        },
        recoveryKind: effectiveRecoveryKind || "npc_reply_loop",
        replyResultOverride: replyResult || null,
        skipExecutionRecording: true
      });
    } else if (effectiveRecoveryKind === "stage_completed") {
      await finalizeFixedScriptTurnExecution({
        stage: context.stage,
        roundNumber: context.roundNumber,
        userInstruction: context.userInstruction,
        scene: context.scene,
        perception: latestPerception,
        interactionMode: context.interactionMode,
        externalInputGuardEnabled: context.externalInputGuardEnabled,
        perceptionSummary,
        plan: context.plan,
        execution: {
          executor: "RecoveryResolver",
          steps: [],
          rawSteps: [],
          durationMs: 0,
          outcome: "当前稳定状态已经等价于这一轮完成。",
          outcomeKind: "completed"
        },
        recoveryKind: `${effectiveRecoveryKind}:${resolvedRecovery.anchorState?.anchorId || "unknown"}`,
        skipExecutionRecording: true
      });
    } else {
      const execution = await runWindowsActions(effectiveWorkerActions, {
        interruptOnExternalInput: context.externalInputGuardEnabled
      });

      await finalizeFixedScriptTurnExecution({
        stage: context.stage,
        roundNumber: context.roundNumber,
        userInstruction: context.userInstruction,
        scene: context.scene,
        perception: latestPerception,
        interactionMode: context.interactionMode,
        externalInputGuardEnabled: context.externalInputGuardEnabled,
        perceptionSummary,
        plan: context.plan,
        execution,
        recoveryKind: `${effectiveRecoveryKind || "worker_actions"}:${resolvedRecovery.anchorState?.anchorId || "unknown"}`
      });
    }

    const progressedState = getState();
    updateAutomation({
      ...advanceAutomationProgress(progressedState.automation),
      totalTurns: progressedState.automation.totalTurns + 1
    });
  } catch (error) {
    if (handleExternalInputInterrupted(error, "失败步骤续跑")) {
      return;
    }

    setLastError(error.message);
      updateAutomation({
        status: "paused"
      });
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "失败步骤续跑失败", {
      error: error.message
    });
    recordAutonomousFailure({
      ...error,
      resumeContext: error.resumeContext || buildResumeContextFromError({
        stage: context.stage,
        roundNumber: context.roundNumber,
        userInstruction: context.userInstruction,
        scene: context.scene,
        perception: context.perception,
        interactionMode: context.interactionMode,
        externalInputGuardEnabled: context.externalInputGuardEnabled,
        perceptionSummary: context.perceptionSummary,
        plan: context.plan
      }, error)
    });
    await appendFailureRescueMessage({
      error,
      stageKey: context.stage?.key || "",
      sceneLabel: "续跑失败",
      perceptionSummary
    });
    throw error;
  } finally {
    turnInFlight = false;
  }
}

async function runUserFixedScriptTurn({
  instruction,
  scene,
  perception,
  interactionMode = "act",
  externalInputGuardEnabled = true
}) {
  const runtimeBefore = getState();
  const nowIso = new Date().toISOString();

  appendMessage(buildUserMessage({
    instruction,
    scene,
    perception,
    origin: "user"
  }));
  appendLog("info", `收到对话输入：${instruction}`, {
    instruction,
    scene,
    interactionMode
  });

  updateAgent({
    mode: "user_priority",
    phase: "user_priority",
    currentObjective: instruction,
    queuedUserObjective: instruction,
    lastUserInstruction: instruction,
    lastAutonomousInstruction: runtimeBefore.agent.lastAutonomousInstruction
  });

  const automationBeforeTurn = runtimeBefore.automation;
  const shouldRestartScript = ["idle", "completed"].includes(automationBeforeTurn.status);
  const shouldResumeScript = automationBeforeTurn.status === "paused";

  if (shouldRestartScript) {
    updateAutomation({
      status: "running",
      mode: "fixed_script",
      instruction,
      armedAt: null,
      armedActionKind: null,
      startsAt: null,
      inputProtectionUntil: null,
      inputProtectionButton: null,
      startedAt: nowIso,
      finishedAt: null,
      stageIndex: 0,
      completedRoundsInStage: 0,
      totalTurns: 0,
      lastThought: null,
      lastOutcome: null,
      lastFailureCode: null,
      lastRecoveryKind: null,
      lastRecoveryAttemptCount: 0
    });
  } else {
    updateAutomation({
      status: "running",
      mode: automationBeforeTurn.mode || "fixed_script",
      instruction: automationBeforeTurn.instruction || instruction,
      armedAt: null,
      armedActionKind: null,
      startsAt: null,
      inputProtectionUntil: null,
      inputProtectionButton: null,
      startedAt: automationBeforeTurn.startedAt || nowIso,
      finishedAt: null,
      ...(shouldResumeScript
        ? {}
        : {
          stageIndex: automationBeforeTurn.stageIndex,
          completedRoundsInStage: automationBeforeTurn.completedRoundsInStage
        })
    });
  }

  const latestAutomationState = getState().automation;
  const upcomingTurn = getUpcomingScriptTurn(latestAutomationState);
  if (!upcomingTurn) {
    updateAgent({
      phase: "waiting",
      currentObjective: "这套安排已经做完",
      queuedUserObjective: null
    });
    return getState();
  }

  await runFixedScriptTurn({
    stage: upcomingTurn.stage,
    roundNumber: upcomingTurn.roundNumber,
    userInstruction: latestAutomationState.instruction || instruction,
    scene,
    perception,
    interactionMode,
    externalInputGuardEnabled
  });

  const progressedState = getState();
  updateAutomation({
    ...advanceAutomationProgress(progressedState.automation),
    totalTurns: progressedState.automation.totalTurns + 1
  });

  return getState();
}

async function maybeRunAutonomousTurn() {
  if (turnInFlight) {
    return;
  }

  const runtimeState = getState();
  const automation = runtimeState.automation;

  if (!runtimeState.agent.autonomousEnabled) {
    return;
  }

  if (runtimeState.status !== "running") {
    return;
  }

  if (runtimeState.status === "paused" || runtimeState.status === "stopped") {
    return;
  }

  if (!automation || ["idle", "paused", "completed"].includes(automation.status)) {
    if ((runtimeState.interactionMode || "act") === "watch") {
      if (voiceAutoCaptureHoldActive) {
        return;
      }
      await maybeRunWatchCommentaryTurn(runtimeState);
    }
    return;
  }

  if (automation.status === "chat_assist") {
    try {
      await runChatAssistTurn(runtimeState);
    } catch (error) {
      if (handleExternalInputInterrupted(error, "帮聊模式")) {
        stopChatAssist({
          reason: "external_input_interrupted",
          message: "你刚才动了鼠标或键盘，我先把帮聊停下来了。",
          appendNotice: true
        });
        appendLog("info", "帮聊模式因人工输入已停止");
        return;
      }
      stopChatAssist({
        reason: "chat_assist_failed",
        message: `帮聊模式已停止：${error.message || "未知错误"}`,
        appendNotice: true,
        riskLevel: "medium"
      });
      appendLog("error", "帮聊模式执行失败", {
        error: error.message
      });
    }
    return;
  }

  turnInFlight = true;

  try {
    if (automation.status === "armed") {
      const startsAtMs = automation.startsAt ? new Date(automation.startsAt).getTime() : 0;

      if (!startsAtMs || Date.now() < startsAtMs) {
        return;
      }

      const armedActionKind = String(automation.armedActionKind || "script_start");
      if (armedActionKind === "resume_failed_step") {
        updateAutomation({
          status: "running",
          armedActionKind: null,
          inputProtectionUntil: null,
          inputProtectionButton: null
        });
        appendLog("info", "失败恢复动作已结束鼠标脱离保护，开始执行");
        await resumeFailedAutomationStep();
        return;
      }
      if (armedActionKind === "skip_failed_segment") {
        const context = pendingResumeContext;
        clearPendingResumeContext({ preserveFailureMeta: true });
        updateAutomation({
          status: "running",
          armedActionKind: null,
          inputProtectionUntil: null,
          inputProtectionButton: null
        });
        appendLog("info", "失败环节跳过已结束鼠标脱离保护，开始执行 skipTo");
        const skipExecution = await executeSkippedSegment(context);
        if (skipExecution?.mode === "inline_actions") {
          const latestPerception = getState().latestPerception || context?.perception || null;
          const perceptionSummary = perceptionSummaryBySource(latestPerception, "agent");
          const execution = await runWindowsActions(skipExecution.actions, {
            interruptOnExternalInput: context.externalInputGuardEnabled
          });
          await finalizeFixedScriptTurnExecution({
            stage: skipExecution.stage,
            roundNumber: skipExecution.roundNumber,
            userInstruction: context.userInstruction,
            scene: context.scene,
            perception: latestPerception,
            interactionMode: context.interactionMode,
            externalInputGuardEnabled: context.externalInputGuardEnabled,
            perceptionSummary,
            plan: context.plan,
            execution,
            recoveryKind: `skip:${context.failedSegmentId || "unknown"}->${context.skipTarget?.segmentId || "unknown"}`
          });
          const progressedState = getState();
          updateAutomation({
            ...advanceAutomationProgress(progressedState.automation),
            totalTurns: progressedState.automation.totalTurns + 1
          });
          return;
        }
        const latestState = getState();
        const upcomingTurn = getUpcomingScriptTurn(latestState.automation);
        if (!upcomingTurn) {
          updateAutomation({
            status: "completed",
            finishedAt: new Date().toISOString()
          });
          updateAgent({
            phase: "waiting",
            currentObjective: "等待下一句指令"
          });
          return;
        }
        const skipTurnResult = await runFixedScriptTurn({
          stage: upcomingTurn.stage,
          roundNumber: upcomingTurn.roundNumber,
          userInstruction: latestState.automation.instruction || latestState.agent.lastUserInstruction || "",
          scene: latestState.scene,
          perception: latestState.latestPerception,
          interactionMode: latestState.interactionMode,
          externalInputGuardEnabled: latestState.externalInputGuardEnabled
        });
        if (skipTurnResult) {
          const progressedState = getState();
          updateAutomation({
            ...advanceAutomationProgress(progressedState.automation),
            totalTurns: progressedState.automation.totalTurns + 1
          });
        }
        return;
      }

      updateAutomation({
        status: "running",
        armedActionKind: null,
        inputProtectionUntil: null,
        inputProtectionButton: null,
        startedAt: new Date().toISOString()
      });
      appendMessage({
        role: "assistant",
        text: "好嘞，这就按刚才盘好的路子稳稳开干！",
        thinkingChain: [],
        perceptionSummary: "自动化已从等待切到执行。",
        sceneLabel: runtimeState.latestPerception?.sceneLabel || "自动运行",
        riskLevel: "low",
        actions: []
      });
      appendLog("info", "固定剧本自动化已开始执行");
    }

    const latestState = getState();
    const upcomingTurn = getUpcomingScriptTurn(latestState.automation);

    if (!upcomingTurn) {
      updateAutomation({
        status: "completed",
        finishedAt: new Date().toISOString()
      });
      updateAgent({
        phase: "waiting",
        currentObjective: "这套安排已经做完"
      });
      appendMessage({
        role: "assistant",
        text: "籽岷的任务我全拿下啦～昂首挺胸等他回来看成果！钱也揣兜里了，街边站得笔直，不乱伸手～",
        thinkingChain: [],
        perceptionSummary: "固定剧本已执行完毕。",
        sceneLabel: latestState.latestPerception?.sceneLabel || "自动运行结束",
        riskLevel: "low",
        actions: []
      });
      return;
    }

    await runFixedScriptTurn({
      stage: upcomingTurn.stage,
      roundNumber: upcomingTurn.roundNumber,
      userInstruction: latestState.automation.instruction || "",
      scene: latestState.scene,
      perception: latestState.latestPerception,
      interactionMode: latestState.interactionMode || "act",
      externalInputGuardEnabled: latestState.externalInputGuardEnabled !== false
    });

    const progressedState = getState();
    updateAutomation({
      ...advanceAutomationProgress(progressedState.automation),
      totalTurns: progressedState.automation.totalTurns + 1
    });
  } catch (error) {
    if (handleExternalInputInterrupted(error, "自主回合")) {
      return;
    }
    setLastError(error.message);
    updateAutomation({
      status: "paused"
    });
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "自主运行回合失败", {
      error: error.message
    });
    recordAutonomousFailure(error);
    await appendFailureRescueMessage({
      error,
      stageKey: getUpcomingScriptTurn(getState().automation)?.stage?.key || "",
      sceneLabel: getState().latestPerception?.sceneLabel || "自动运行失败",
      perceptionSummary: perceptionSummaryBySource(getState().latestPerception, "agent")
    });
  } finally {
    turnInFlight = false;
  }
}

async function waitForTurnSlot() {
  const startedAt = Date.now();

  while (turnInFlight) {
    if (Date.now() - startedAt >= TURN_SLOT_TIMEOUT_MS) {
      throw new Error("当前已有一轮执行在进行中，等待超时。");
    }

    await sleep(TURN_SLOT_POLL_MS);
  }

  turnInFlight = true;
}

async function handleControl(request, response) {
  const { action, scene, interactionMode, externalInputGuardEnabled } = await readRequestBody(request);

  if (scene) {
    setScene(scene);
    appendLog("info", `场景已切换为 ${scene}`, { scene });
  }

  if (interactionMode) {
    if (!["watch", "act"].includes(interactionMode)) {
      return sendJson(response, 400, { ok: false, error: "Unsupported interaction mode" });
    }

    setInteractionMode(interactionMode);
    appendLog("info", interactionMode === "watch" ? "\u524d\u53f0\u5df2\u5207\u5230\u89c2\u770b\u6a21\u5f0f" : "\u524d\u53f0\u5df2\u5207\u5230\u884c\u52a8\u6a21\u5f0f", {
      interactionMode
    });
  }

  if (typeof externalInputGuardEnabled === "boolean") {
    setExternalInputGuardEnabled(externalInputGuardEnabled);
    appendLog("info", externalInputGuardEnabled
      ? "已开启人类介入保护"
      : "已关闭人类介入保护");
  }

  const transitions = {
    start: () => {
      setStatus("running");
      autoCaptureService.start();
    },
    pause: () => {
      setStatus("paused");
      autoCaptureService.pause();
      const automation = getState().automation;
      if (automation.status === "armed" || automation.status === "running" || automation.status === "chat_assist") {
        updateAutomation({
          status: "paused"
        });
      }
    },
    resume: () => {
      setStatus("running");
      autoCaptureService.resume();
      const automation = getState().automation;
      if (automation.status === "paused" && automation.instruction) {
        updateAutomation({
          status: automation.mode === "chat_assist"
            ? "chat_assist"
            : automation.startedAt
              ? "running"
              : "armed"
        });
      }
    },
    stop: () => {
      setStatus("stopped");
      autoCaptureService.stop();
      const automation = getState().automation;
      if (automation.status !== "idle" && automation.status !== "completed") {
        updateAutomation({
          status: "paused"
        });
      }
    },
    reset: () => {
      autoCaptureService.stop();
      clearPendingResumeContext();
      latestCaptureImageDataUrl = null;
      resetRuntime();
      appendLog("info", "运行上下文已清空");
    },
    resume_failed_step: async () => {
      armResumeFailedStep();
    },
    skip_failed_segment: async () => {
      armSkipFailedSegment();
    }
  };

  if (action) {
    if (!transitions[action]) {
      return sendJson(response, 400, { ok: false, error: "Unsupported control action" });
    }

    await transitions[action]();

    if (action !== "reset") {
      appendLog("info", `控制动作已执行：${action}`);
    }
  }

  return sendJson(response, 200, statePayload());
}
async function handleCaptureControl(request, response) {
  const { action } = await readRequestBody(request);

  const transitions = {
    start: () => autoCaptureService.start(),
    pause: () => autoCaptureService.pause(),
    resume: () => autoCaptureService.resume(),
    stop: () => autoCaptureService.stop(),
    trigger_once: () => autoCaptureService.triggerOnce()
  };

  if (!transitions[action]) {
    return sendJson(response, 400, { ok: false, error: "Unsupported capture action" });
  }

  await transitions[action]();

  return sendJson(response, 200, statePayload());
}

async function handleCaptureStatus(request, response) {
  return sendJson(response, 200, {
    ok: true,
    capture: getState().capture
  });
}

async function handleTurn(request, response) {
  const body = await readRequestBody(request);
  const instruction = String(body.instruction || "").trim();
  const state = getState();
  const scene = body.scene || state.scene;
  const effectiveInteractionMode = state.interactionMode || "act";

  if (!instruction) {
    return sendJson(response, 400, { ok: false, error: "Instruction is required" });
  }

  if (state.status === "paused") {
    return sendJson(response, 409, { ok: false, error: "当前系统处于暂停状态，请先继续运行。" });
  }

  if (state.status === "stopped") {
    return sendJson(response, 409, { ok: false, error: "当前系统已停止，请先重新启动。" });
  }

  if (state.status === "idle") {
    setStatus("running");
    syncAutoCaptureForInteractionMode(effectiveInteractionMode);
    appendLog("info", "系统从空闲状态自动进入运行状态");
  }

  setScene(scene);
  setLastError(null);
  updateAgent({
    mode: "user_priority",
    phase: turnInFlight ? "queued" : "user_priority",
    queuedUserObjective: instruction,
    currentObjective: instruction
  });

  try {
    await waitForTurnSlot();
    const nextState = await runUserFixedScriptTurn({
      instruction,
      scene,
      perception: state.latestPerception,
      interactionMode: state.interactionMode || "act",
      externalInputGuardEnabled: state.externalInputGuardEnabled !== false
    });

    return sendJson(response, 200, {
      ...statePayload(),
      state: nextState
    });
  } catch (error) {
    if (handleExternalInputInterrupted(error, "对话回合")) {
      return sendJson(response, 409, {
        ok: false,
        error: error.message,
        errorCode: error.code,
        state: getState()
      });
    }
    setLastError(error.message);
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "本轮执行失败", { error: error.message });
    await appendFailureRescueMessage({
      error,
      sceneLabel: "执行失败",
      perceptionSummary: perceptionSummaryBySource(getState().latestPerception, "agent")
    });
    return sendJson(response, 500, {
      ok: false,
      error: error.message,
      state: getState()
    });
  } finally {
    turnInFlight = false;
  }
}

async function handleAnalyzeImage(request, response) {
  const body = await readRequestBody(request);
  const imageDataUrl = requireDataUrl(body.imageDataUrl);
  const imageName = String(body.imageName || "untitled-image").trim();

  appendLog("info", `收到截图分析请求：${imageName}`);

  try {
    const perception = await analyzeScreenshot({
      imageInput: imageDataUrl
    });

    latestCaptureImageDataUrl = imageDataUrl;
    setLatestPerception(perception, {
      source: "manual_upload",
      imageName,
      analyzedAt: new Date().toISOString()
    });
    setCaptureState({
      lastImageSource: "manual_upload"
    });

    appendLog("info", "截图 OCR 完成", {
      imageName,
      extractedLength: perception.ocrText.length
    });
    appendLog("info", "截图场景识别完成", {
      sceneType: perception.sceneType,
      npcCount: perception.npcNames.length,
      optionCount: perception.interactiveOptions.length
    });

    return sendJson(response, 200, {
      ok: true,
      state: getState()
    });
  } catch (error) {
    setLastError(error.message);
    appendLog("error", "截图分析失败", {
      imageName,
      error: error.message
    });
    return sendJson(response, 500, {
      ok: false,
      error: error.message,
      state: getState()
    });
  }
}

async function handleVoiceTranscription(request, response) {
  const body = await readRequestBody(request);
  const audioDataUrl = requireAudioDataUrl(body.audioDataUrl);
  let audioPath = null;

  appendLog("info", "收到语音转写请求");

  try {
    audioPath = await writeTempAudioFile(audioDataUrl);
    const text = await transcribeWithAliyunAsr({
      audioPath
    });

    appendLog("info", "语音转写完成", {
      textLength: text.length
    });

    return sendJson(response, 200, {
      ok: true,
      text
    });
  } catch (error) {
    appendLog("error", "语音转写失败", {
      error: error.message
    });
    return sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  } finally {
    if (audioPath) {
      await rm(audioPath, { force: true }).catch(() => {});
    }
  }
}

async function handleVoiceActivity(request, response) {
  const body = await readRequestBody(request);
  const active = Boolean(body.active);
  const reason = String(body.reason || (active ? "speech" : "released")).trim();
  const allowAutoCaptureResume = reason === "manual_stop" || reason === "idle_timeout";

  if (active) {
    voiceAutoCaptureHoldActive = true;
    autoCaptureService.pause();
  } else {
    voiceAutoCaptureHoldActive = !allowAutoCaptureResume;
    if (
      allowAutoCaptureResume
      && (getState().interactionMode || "watch") === "watch"
      && getState().status === "running"
    ) {
      ensureAutoCaptureRunning();
    }
  }

  appendLog("info", active ? "语音占用已暂停自动轮询" : "语音占用已释放自动轮询", { reason });
  return sendJson(response, 200, { ok: true, holdActive: voiceAutoCaptureHoldActive });
}

async function handleChat(request, response) {
  const body = await readRequestBody(request);
  const instruction = String(body.instruction || "").trim();
  const automationTriggerConfig = getAutomationTriggerConfig(instruction);
  const automationTriggered = hasAutomationTrigger(instruction);
  const chatAssistTriggered = hasChatAssistTrigger(instruction);
  const requestedInteractionMode = typeof body.interactionMode === "string"
    ? body.interactionMode.trim()
    : "";
  const requestedExternalInputGuardEnabled = typeof body.externalInputGuardEnabled === "boolean"
    ? body.externalInputGuardEnabled
    : null;

  if (!instruction) {
    return sendJson(response, 400, { ok: false, error: "Instruction is required" });
  }

  if (requestedInteractionMode && !["watch", "act"].includes(requestedInteractionMode)) {
    return sendJson(response, 400, { ok: false, error: "Unsupported interaction mode" });
  }

  const effectiveInteractionMode = automationTriggered
    ? "act"
    : requestedInteractionMode || getState().interactionMode || "watch";

  const automationState = getState().automation;
  if (automationState?.status === "chat_assist" && !chatAssistTriggered) {
    stopChatAssist({
      reason: "user_instruction_override"
    });
    appendLog("info", "帮聊模式已因新的用户指令停止", {
      instruction
    });
  }

  setStatus("running");
  syncAutoCaptureForInteractionMode(effectiveInteractionMode);
  setLastError(null);
  clearPendingResumeContext();
  setInteractionMode(effectiveInteractionMode);
  if (requestedExternalInputGuardEnabled !== null) {
    setExternalInputGuardEnabled(requestedExternalInputGuardEnabled);
  }

  appendMessage(buildUserMessage({
    instruction,
    scene: getState().scene,
    perception: getState().latestPerception,
    origin: "user"
  }));

  if (chatAssistTriggered) {
    armChatAssist(instruction);
    appendLog("info", "帮聊模式已启动", {
      instruction,
      triggerWord: "帮我聊吧"
    });
    appendMessage({
      role: "assistant",
      text: "收到，我来帮你盯着当前聊天页接话；你一动鼠标或键盘，我就立刻停。",
      thinkingChain: [],
      recoveryLine: "",
      perceptionSummary: "帮聊模式已启动，只在当前聊天页按画面内容续聊并点击发送。",
      sceneLabel: getState().latestPerception?.sceneLabel || "等待聊天页",
      riskLevel: "low",
      actions: []
    });
  } else if (automationTriggered) {
    armAutomationScript(instruction, automationTriggerConfig);
    appendLog("info", "固定剧本自动化已布置", {
      instruction,
      startsAt: getState().automation.startsAt,
      triggerWord: automationTriggerConfig.triggerWord
    });
    appendMessage({
      role: "assistant",
      text: automationTriggerConfig.armedNotice,
      thinkingChain: [],
      recoveryLine: "",
      perceptionSummary: "固定剧本已经布置完成，当前只是在等待启动。",
      sceneLabel: getState().latestPerception?.sceneLabel || "等待启动",
      riskLevel: "low",
      actions: []
    });
  } else if ((getState().interactionMode || "watch") === "watch") {
    const latestState = getState();
    await runWatchUserReplyTurn({
      instruction,
      scene: latestState.scene,
      perception: latestState.latestPerception,
      conversationMessages: latestState.messages.slice(0, -1)
    });
  } else {
    appendLog("info", "本轮未命中固定剧本触发词", {
      instruction,
      triggerWord: "加油 / 我想敲他板砖 / 我想偷点东西"
    });
    appendMessage({
      role: "assistant",
      text: "收到，但这句还没命中自动化触发词。",
      thinkingChain: [],
      recoveryLine: "只有你说出触发词，我才会布置整套自动化。",
      perceptionSummary: "本轮没有命中固定剧本触发词，当前不会布置自动化主流程。",
      sceneLabel: getState().latestPerception?.sceneLabel || "等待指令",
      riskLevel: "low",
      actions: []
    });
  }

  return sendJson(response, 200, statePayload());
}

async function handleNpcChatReply(request, response) {
  const body = await readRequestBody(request);
  const instruction = String(body.instruction || "").trim();
  const maxRounds = Math.max(1, Number(body.maxRounds) || NPC_CHAT_MAX_ROUNDS);
  const closeAfterSend = body.closeAfterSend !== false;
  const requestedScriptKey = String(body.scriptKey || "").trim();
  const requestedScriptRoundNumber = Math.max(1, Number(body.scriptRoundNumber) || 1);
  const requestedExternalInputGuardEnabled = typeof body.externalInputGuardEnabled === "boolean"
    ? body.externalInputGuardEnabled
    : null;

  if (!instruction) {
    return sendJson(response, 400, { ok: false, error: "Instruction is required" });
  }

  if (!latestCaptureImageDataUrl) {
    return sendJson(response, 409, {
      ok: false,
      error: "No capture image is available for current NPC chat reply",
      state: getState()
    });
  }

  await waitForTurnSlot();

  const externalInputGuardEnabled = requestedExternalInputGuardEnabled !== null
    ? requestedExternalInputGuardEnabled
    : getState().externalInputGuardEnabled !== false;
  const requestedStage = findFixedScriptStage(requestedScriptKey);
  const plan = requestedStage
    ? buildFixedScriptPlan({
      stage: requestedStage,
      roundNumber: requestedScriptRoundNumber,
      scene: getState().scene,
      userInstruction: instruction
    })
    : null;

  try {
    const replyResult = await maybeReplyFromCurrentChatScreen({
      instruction,
      plan,
      perceptionSummary: perceptionSummaryBySource(getState().latestPerception, "agent"),
      externalInputGuardEnabled,
      maxRounds,
      closeAfterSend
    });

    if (!replyResult) {
      return sendJson(response, 409, {
        ok: false,
        error: "Current screen is not a ready NPC chat screen",
        state: getState()
      });
    }

    return sendJson(response, 200, {
      ok: true,
      rounds: replyResult.rounds,
      maxRounds,
      closeAfterSend,
      stopReason: replyResult.stopReason,
      replyText: replyResult.replyText,
      state: getState()
    });
  } catch (error) {
    if (handleExternalInputInterrupted(error, "当前聊天页续聊")) {
      return sendJson(response, 409, {
        ok: false,
        error: error.message,
        errorCode: error.code,
        state: getState()
      });
    }
    throw error;
  } finally {
    turnInFlight = false;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(response, 200, statePayload());
    }

    if (request.method === "GET" && url.pathname === "/api/capture/status") {
      return handleCaptureStatus(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/control") {
      return handleControl(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/capture/control") {
      return handleCaptureControl(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/turn") {
      return handleTurn(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/analyze-image") {
      return handleAnalyzeImage(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/voice/transcribe") {
      return handleVoiceTranscription(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/voice/activity") {
      return handleVoiceActivity(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/chat/npc-reply") {
      return handleNpcChatReply(request, response);
    }

    if (request.method === "GET") {
      return serveStatic(response, url.pathname);
    }

    return sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    if (error.code === "ENOENT") {
      return sendJson(response, 404, { ok: false, error: "Not found" });
    }

    appendLog("error", "服务端异常", { error: error.message });
    return sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, () => {
  appendLog("info", "视频实验控制台已启动", { port });
  console.log(`Moonlight Blade Auto Worker listening on http://localhost:${port}`);
  setInterval(() => {
    maybeRunAutonomousTurn().catch((error) => {
      appendLog("error", "自主运行定时任务失败", { error: error.message });
    });
  }, AUTONOMOUS_INTERVAL_MS);
});
