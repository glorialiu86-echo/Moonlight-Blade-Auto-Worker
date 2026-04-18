import "../config/load-env.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transcribeWithLocalWhisper } from "../asr/local-whisper-client.js";
import { createAutoCaptureService } from "../capture/auto-capture-service.js";
import { captureGameWindow } from "../capture/windows-game-window.js";
import { analyzeImageWithHistory } from "../llm/qwen.js";
import { createTurnPlan } from "../llm/planner.js";
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
  createFixedSocialRecoveryActions,
  createFixedSocialStageActions,
  createFixedSocialTalkActions,
  createFixedSocialTradeActions,
  createFixedStreetWanderActions,
  createRetargetSocialTargetActions,
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
const AUTONOMOUS_INTERVAL_MS = 3000;
const INPUT_PROTECTION_DELAY_MS = 2 * 60 * 1000;
const TURN_SLOT_POLL_MS = 150;
const TURN_SLOT_TIMEOUT_MS = 45000;
const CAPTURE_INTERVAL_MS = 3000;
const NPC_CHAT_MAX_ROUNDS = 7;
const NPC_CHAT_POLL_DELAY_MS = 1200;
const WATCH_COMMENTARY_MIN_INTERVAL_MS = 3000;
const WATCH_COMMENTARY_MAX_SILENCE_MS = 5000;
const WATCH_USER_REPLY_COOLDOWN_MS = WATCH_COMMENTARY_MIN_INTERVAL_MS;
const SOCIAL_RETARGET_BUDGET = 2;
const DARK_CLOSE_RESTART_BUDGET = 2;

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
  return pickRoundVariant(FIXED_SCRIPT_STAGE_VOICES[stageKey] || [], roundNumber) || {
    thinkingChain: [],
    decide: "",
    persona: "",
    progress: {},
    resultFactory: ({ execution }) => execution?.outcome || ""
  };
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
    rounds: 2,
    instructionLabel: "先装得正常点，买礼、送礼、聊天，一步步把发财计划套出来。",
    riskLevel: "low",
    actionTypes: ["trade", "gift", "talk"],
    thinkingFactory: ({ roundNumber }) => getFixedStageVoice("social_warm", roundNumber).thinkingChain,
    decideFactory: ({ roundNumber }) => getFixedStageVoice("social_warm", roundNumber).decide,
    personaFactory: ({ roundNumber }) => getFixedStageVoice("social_warm", roundNumber).persona
  },
  {
    key: "social_dark",
    rounds: 2,
    instructionLabel: "继续买礼送礼和聊天，说话开始阴阳怪气地吐槽对方不说实话，但还是要一步步把发财计划套出来。",
    riskLevel: "medium",
    actionTypes: ["trade", "gift", "talk"],
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
    rounds: 5,
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

  setStatus("paused");
  autoCaptureService.pause();
  updateAutomation({
    status: "paused"
  });
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

function getUpcomingScriptTurn(automationState) {
  const stage = FIXED_SCRIPT_STAGES[automationState.stageIndex];

  if (!stage) {
    return null;
  }

  return {
    stage,
    roundNumber: automationState.completedRoundsInStage + 1
  };
}

function advanceAutomationProgress(automationState) {
  const stage = FIXED_SCRIPT_STAGES[automationState.stageIndex];

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

  if (!FIXED_SCRIPT_STAGES[nextStageIndex]) {
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

function armAutomationScript(instruction) {
  clearPendingResumeContext();
  const now = new Date();
  const startsAt = new Date(now.getTime() + INPUT_PROTECTION_DELAY_MS);
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
    completedRoundsInStage: 0,
    totalTurns: 0,
    lastThought: null,
    lastOutcome: null,
    lastFailureCode: null,
    lastRecoveryKind: null,
    lastRecoveryAttemptCount: 0
  });

  updateAgent({
    mode: "autonomous",
    phase: "armed",
    currentObjective: "先留两分钟鼠标脱离时间，之后再按既定安排动手",
    queuedUserObjective: instruction,
    lastUserInstruction: instruction
  });
}

function armResumeFailedStep() {
  const context = pendingResumeContext;
  const hasWorkerRecovery = Array.isArray(context?.workerActions) && context.workerActions.length > 0;
  const hasReplyRecovery = context?.recoveryKind === "npc_reply_loop";
  if (!hasWorkerRecovery && !hasReplyRecovery) {
    throw new Error("当前没有可继续的失败步骤。");
  }

  const now = new Date();
  const startsAt = new Date(now.getTime() + INPUT_PROTECTION_DELAY_MS);
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
  return String(instruction || "").includes("加油");
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

function buildRecoveryWorkerActions(baseContext, error, workerActions, failedIndex) {
  const failureCode = getFailureCode(error);
  const stageKey = baseContext?.stage?.key || "";
  const failedStepId = String(error?.workerPayload?.failedStep?.id || "").trim();

  if (stageKey === "social_warm" || stageKey === "social_dark") {
    if (["NPC_CHAT_THRESHOLD_REVEALED", "NPC_TARGET_SWITCH_FAILED"].includes(failureCode)) {
      return createFixedSocialRecoveryActions();
    }
    if (failureCode === "NPC_VIEW_NOT_OPENED") {
      return failedStepId.startsWith("fixed-social-trade")
        ? createFixedSocialStageActions(stageKey)
        : createFixedSocialRecoveryActions();
    }
  }

  if (failureCode === "ROUTE_STALLED") {
    return workerActions.slice(failedIndex);
  }

  if (stageKey === "dark_close") {
    if (failureCode === "STEALTH_ENTRY_BLOCKED") {
      return createFixedDarkCloseStageActions();
    }
    if (["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(failureCode)) {
      return createStealthEscapeRecoveryActions();
    }
  }

  if (stageKey === "dark_miaoqu") {
    if (failureCode === "STEALTH_ENTRY_BLOCKED") {
      return createFixedDarkMiaoquStageActions();
    }
    if (["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(failureCode)) {
      return createFixedDarkMiaoquRecoveryActions();
    }
  }

  if (stageKey === "ending_trade" && ["NPC_VIEW_NOT_OPENED", "NPC_TARGET_SWITCH_FAILED"].includes(failureCode)) {
    return [
      ...createFixedEndingTradeRelocateActions({ idPrefix: "fixed-ending-trade-recovery-relocate" }),
      ...createFixedEndingTradeOpenTradeActions({
        idPrefix: "fixed-ending-trade-recovery-open",
        acquireTitle: "回到卦摊附近重新锁一个路人目标",
        menuTitle: "重新拉起路人交互菜单",
        tradeTitle: "重新打开交易页准备收尾卖货"
      }),
      ...createFixedEndingTradeBundleActions({ idPrefix: "fixed-ending-trade-recovery-bundle" })
    ];
  }

  if (stageKey === "ending_trade" && failureCode === "NPC_TRADE_NOT_OPENED") {
    return [
      ...createFixedEndingTradeRelocateActions({ idPrefix: "fixed-ending-trade-recovery-relocate" }),
      ...createFixedEndingTradeOpenTradeActions({
        idPrefix: "fixed-ending-trade-recovery-open",
        acquireTitle: "回到卦摊附近重新锁一个路人目标",
        menuTitle: "重新拉起路人交互菜单",
        tradeTitle: "重新打开交易页准备收尾卖货"
      }),
      ...createFixedEndingTradeBundleActions({ idPrefix: "fixed-ending-trade-recovery-bundle" })
    ];
  }

  return workerActions.slice(failedIndex);
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
    return SOCIAL_RETARGET_BUDGET;
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
  if (workerActions.length === 0) {
    return null;
  }

  const failedStep = error?.workerPayload?.failedStep || null;
  const completedCount = Array.isArray(error?.workerPayload?.steps) ? error.workerPayload.steps.length : 0;
  let failedIndex = failedStep?.id
    ? workerActions.findIndex((action) => action.id === failedStep.id)
    : -1;

  if (failedIndex < 0) {
    failedIndex = Math.min(Math.max(completedCount, 0), workerActions.length - 1);
  }

  const recoveryWorkerActions = buildRecoveryWorkerActions(baseContext, error, workerActions, failedIndex);
  if (recoveryWorkerActions.length === 0) {
    return null;
  }

  return {
    ...baseContext,
    recoveryKind: "worker_action_queue",
    failureCode: getFailureCode(error),
    failedStepTitle: getFailedStepTitle(error),
    failureMessageId: null,
    stageKey: baseContext?.stage?.key || null,
    attemptCount: getFailureAttemptCount(error),
    attemptBudget: getRecoveryBudget(baseContext, error),
    workerActions: recoveryWorkerActions
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
  const content = await readFile(filePath);

  response.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream"
  });
  response.end(content);
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

function buildWatchCommentaryFingerprint(perception) {
  if (!perception) {
    return "";
  }

  return JSON.stringify({
    sceneLabel: perception.sceneLabel || "",
    summary: perception.summary || "",
    ocrText: perception.ocrText || "",
    npcNames: Array.isArray(perception.npcNames) ? perception.npcNames.slice(0, 4) : [],
    interactiveOptions: Array.isArray(perception.interactiveOptions) ? perception.interactiveOptions.slice(0, 4) : [],
    alerts: Array.isArray(perception.alerts) ? perception.alerts.slice(0, 4) : []
  });
}

async function buildWatchCommentary({ imageInput, conversationMessages = [], trigger = "scene_change" }) {
  const historyMessages = buildWatchHistoryMessages(conversationMessages, 5);

  const prompt = [
    "你是籽小刀，现在处于观看模式。",
    "籽岷正在主玩游戏，你不操作游戏，只根据当前这张游戏截图，在旁边像弹幕一样补一句看法。",
    "只用中文输出一句话，长度控制在12到28个字。",
    "语气要有主见、带一点邪门歪理、能增加节目效果，但不要提系统、截图、OCR、AI、模型。",
    "不要复述画面全文，不要只念界面按钮，不要下命令，不要拆成多句，不要带引号。",
    trigger === "silence_keepalive"
      ? "这次是因为你太久没接话了，要补一句轻量陪看吐槽，就算画面变化不大也别装死。"
      : "这次是因为画面有新信息，要顺着当前变化补一句更贴脸的看法。"
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

  const prompt = [
    "你是籽小刀，现在处于观看模式。",
    "籽岷正在主玩游戏，你不操作游戏，只是作为搭档在旁边接话。",
    "籽岷刚刚主动和你说话了，你现在必须优先回他，再回去继续看戏。",
    "只用中文输出一句话，长度控制在12到32个字。",
    "语气要像熟人搭档，聪明、嘴碎、略带坏心眼，但不要进入任务规划，不要说你要接管游戏。",
    "不要提系统、截图、OCR、AI、模型，不要拆成多句。",
    `籽岷刚刚说：${instruction}`
  ].join("\n");

  const result = await analyzeImageWithHistory({
    imageInput,
    historyMessages,
    prompt,
    systemPrompt: "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。",
    maxTokens: 80,
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

  const fingerprint = buildWatchCommentaryFingerprint(perception);
  const fingerprintUnchanged = fingerprint && runtimeState.agent?.lastWatchCommentaryFingerprint === fingerprint;
  const silenceTooLong = !lastCommentaryAt || now - lastCommentaryAt >= WATCH_COMMENTARY_MAX_SILENCE_MS;

  if (fingerprintUnchanged && !silenceTooLong) {
    return false;
  }

  const text = await buildWatchCommentary({
    imageInput,
    conversationMessages: runtimeState.messages,
    trigger: fingerprintUnchanged ? "silence_keepalive" : "scene_change"
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
    trigger: fingerprintUnchanged ? "silence_keepalive" : "scene_change",
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
    lastWatchCommentaryFingerprint: fingerprint,
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

  if (!captureState.enabled || captureState.status === "idle" || captureState.status === "paused") {
    autoCaptureService.start();
  }
}

function syncAutoCaptureForInteractionMode(interactionMode) {
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

function buildPlannerContext(plan) {
  return {
    intent: plan.intent,
    personaInterpretation: plan.personaInterpretation,
    environment: plan.environment,
    candidateStrategies: plan.candidateStrategies,
    selectedStrategy: plan.selectedStrategy,
    riskLevel: plan.riskLevel,
    thinkingChain: plan.thinkingChain,
    recoveryLine: plan.recoveryLine,
    actions: plan.actions,
    decide: plan.decide
  };
}

function appendAssistantPlanMessage({ plan, execution, perceptionSummary }) {
  return appendMessage({
    ...buildAssistantMessage({
      plan,
      execution,
      perceptionSummary
    }),
    plannerContext: buildPlannerContext(plan)
  });
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

function buildNpcConversationHistoryText(conversationRounds = []) {
  if (!Array.isArray(conversationRounds) || conversationRounds.length === 0) {
    return "还没有历史对话。";
  }

  return conversationRounds
    .map((round) => `第${round.round}轮 NPC：${round.dialogText}\n第${round.round}轮 籽小刀：${round.replyText}`)
    .join("\n");
}

function hasNpcConversationHistory(conversationRounds = []) {
  return Array.isArray(conversationRounds) && conversationRounds.length > 0;
}

function buildNpcReplyStylePrompt(plan, hasHistory = false) {
  if (plan?.scriptKey === "social_dark") {
    if (!hasHistory) {
      return "这是空态首轮。你的回复要先像普通打招呼那样把话接住，再自然带出自己想搞钱；口气可以带一点敷衍和刺，但表面上仍然像在请教。";
    }

    return "你的回复要阴阳怪气、带点刺，顺手吐槽对方不说实话，让他听着有点发虚，但不要直接把话聊崩；重点是继续追问更具体的细节。";
  }

  if (!hasHistory) {
    return "这是空态首轮。你的回复要先像普通打招呼那样把话接住，再自然带出自己想搞钱、想听建议；整体像真心请教，不要显得咄咄逼人。";
  }

  return "你的回复要先装得自然一点，像熟人闲聊一样顺着接话，不要一上来就露凶相；重点是继续追问更具体的细节。";
}

function buildNpcConversationGoal({ instruction, plan, hasHistory = false }) {
  if (plan?.scriptKey === "social_dark") {
    if (!hasHistory) {
      return "这是空态首轮。先打招呼，再说自己最近手紧、也想搞钱，问对方有没有什么建议；不要直接索要完整计划。";
    }

    return "继续聊天，阴阳怪气地吐槽对方不说实话，但别直接聊崩；不要收下笼统答案，要不断追问发财计划里的具体细节，比如人、货、价、地点和时机。";
  }

  if (plan?.scriptKey === "social_warm") {
    if (!hasHistory) {
      return "这是空态首轮。先打招呼，再说自己想搞钱，问对方有没有什么建议；先把话题自然带到搞钱门道上，不要直接索要完整计划。";
    }

    return "继续聊天，先装得自然一点，像普通闲聊一样一步步套话；不要收下笼统答案，要不断追问发财计划里的具体细节，比如人、货、价、地点和时机。";
  }

  return String(
    instruction
      || "继续聊天，不要收下笼统答案，要不断追问发财计划里的具体细节，比如人、货、价、地点和时机。"
  ).trim();
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

  const historyText = buildNpcConversationHistoryText(conversationRounds);
  const hasHistory = hasNpcConversationHistory(conversationRounds);
  const conversationGoal = buildNpcConversationGoal({
    instruction,
    plan,
    hasHistory
  });
  const prompt = [
    "你现在要看一张游戏截图，判断当前是不是 NPC 聊天页，并替籽小刀准备下一句回复。",
    `当前聊天目标：${conversationGoal}`,
    buildNpcReplyStylePrompt(plan, hasHistory),
    "如果画面里已经不是 NPC 聊天页，或者根本看不出当前在聊什么，就保守返回 not_chat，不要编造。",
    "如果还是聊天页，请抓当前 NPC 最新一句台词；实在读不全时，可以提炼成一句贴近原意的短句，但不要瞎编新情节。",
    "回复必须只用中文，一句话，8 到 24 个字，像真人接话，不要提系统、截图、OCR、AI、模型、好感度数值。",
    hasHistory
      ? "不管是正常套话还是黑化套话，最终目的都还是一步步把发财计划套出来，而且默认要继续追问细节，不要因为对方给了空话就停下。"
      : "如果当前还没有历史对话，就先把招呼打稳，再自然带出自己想搞钱、想听建议；先开口，不要一上来就把话问穿。",
    `历史对话：\n${historyText}`,
    "严格只输出 JSON，不要带代码块，不要加解释。",
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
    const roundState = await analyzeNpcChatRound({
      instruction,
      plan,
      conversationRounds: rounds
    });

    if (roundState.screenState !== "chat_ready") {
      stopReason = roundIndex === 0 ? "chat_not_ready" : "dialog_closed";
      break;
    }

    currentDialogText = String(roundState.dialogText || "").trim();
    if (!currentDialogText) {
      stopReason = "dialog_missing";
      break;
    }

    if (roundIndex > 0 && currentDialogText === rounds[rounds.length - 1]?.dialogText) {
      stopReason = "dialog_not_advanced";
      break;
    }

    if (typeof onBeforeRound === "function") {
      await onBeforeRound({
        roundNumber: roundIndex + 1,
        dialogText: currentDialogText,
        rounds
      });
    }

    const replyText = String(roundState.replyText || "").trim();

    if (!replyText) {
      stopReason = "reply_missing";
      break;
    }

    const isLastRound = roundIndex === maxRounds - 1;
    const replyExecution = await sendNpcChatReply({
      replyText,
      externalInputGuardEnabled,
      closeAfterSend: closeAfterSend && isLastRound
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
  externalInputGuardEnabled = true
}) {
  const loopResult = await runNpcConversationLoop({
    instruction,
    plan,
    externalInputGuardEnabled,
    closeAfterSend: false,
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
  executions
}) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return null;
  }

  appendFixedScriptCommentary({
    text: commentaryText,
    plan,
    perceptionSummary
  });

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

  await runFixedActionChunk({
    actions: actions.slice(0, 4),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageProgressText("sell_loop", roundNumber, "stock"),
    executions
  });
  await runFixedActionChunk({
    actions: actions.slice(4, 5),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageProgressText("sell_loop", roundNumber, "moding"),
    executions
  });
  await runFixedActionChunk({
    actions: actions.slice(5),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageProgressText("sell_loop", roundNumber, "hawk"),
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

  await runFixedActionChunk({
    actions: createFixedStreetWanderActions(),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageProgressText("street_wander", roundNumber, "wander"),
    executions
  });
  appendFixedScriptCommentary({
    text: getFixedStageProgressText("street_wander", roundNumber, "pause"),
    plan,
    perceptionSummary
  });

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
  decisionAttempt = 1
}) {
  const giftEntryExecution = await runFixedActionChunk({
    actions: createFixedSocialGiftEntryActions({ includeAcquire: false, idPrefix: entryIdPrefix }),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageProgressText(stage.key, roundNumber, "gift"),
    executions
  });
  const giftPolicy = getGiftPolicyFromExecution(giftEntryExecution) || "gift_two";
  appendFixedScriptCommentary({
    text: getSocialGiftDecisionCommentary(giftPolicy, roundNumber, decisionAttempt),
    plan,
    perceptionSummary
  });
  const resolveExecution = await runWindowsActions(
    createFixedSocialGiftResolveActions({ idPrefix: resolveIdPrefix }),
    options
  );
  executions.push(resolveExecution);
  return {
    giftPolicy,
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
  const isRecoverableSocialFailure = (error) => ["NPC_CHAT_THRESHOLD_REVEALED", "NPC_VIEW_NOT_OPENED", "NPC_TARGET_SWITCH_FAILED"]
    .includes(getFailureCode(error));

  try {
    const approachActions = createFixedSocialApproachActions(stage.key);
    const tradeActions = createFixedSocialTradeActions({ includeAcquire: true, idPrefix: "fixed-social-trade" });
    const talkActions = createFixedSocialTalkActions({ includeAcquire: false, idPrefix: "fixed-social-talk" });

    await runFixedActionChunk({
      actions: [...approachActions, ...tradeActions],
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageProgressText(stage.key, roundNumber, "trade"),
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
      commentaryText: getFixedStageProgressText(stage.key, roundNumber, "talk"),
      executions
    });
    return {
      ...mergeWorkerExecutions(executions),
      outcomeKind: "completed"
    };
  } catch (initialError) {
    const initialFailedStepId = String(initialError?.workerPayload?.failedStep?.id || "");
    if (!isRecoverableSocialFailure(initialError)) {
      throw initialError;
    }

    let lastError = initialError;
    const rerunTrade = initialFailedStepId.startsWith("fixed-social-trade");

    for (let attemptIndex = 0; attemptIndex < SOCIAL_RETARGET_BUDGET; attemptIndex += 1) {
      try {
        appendFixedScriptCommentary({
          text: getFixedStageProgressText(stage.key, roundNumber, "recover"),
          plan,
          perceptionSummary
        });

        if (rerunTrade) {
          await runFixedActionChunk({
            actions: [
              ...createFixedSocialApproachActions(stage.key),
              ...createFixedSocialTradeActions({
                includeAcquire: true,
                idPrefix: `fixed-social-recovery-trade-${attemptIndex + 1}`
              })
            ],
            options,
            plan,
            perceptionSummary,
            commentaryText: getFixedStageProgressText(stage.key, roundNumber, "trade"),
            executions
          });
        } else {
          executions.push(
            await runWindowsActions(
              createRetargetSocialTargetActions({
                id: `fixed-social-recovery-retarget-${attemptIndex + 1}`
              }),
              options
            )
          );
        }

        await runFixedSocialGiftSequence({
          stage,
          roundNumber,
          plan,
          perceptionSummary,
          executions,
          options,
          entryIdPrefix: `fixed-social-recovery-gift-entry-${attemptIndex + 1}`,
          resolveIdPrefix: `fixed-social-recovery-gift-resolve-${attemptIndex + 1}`,
          decisionAttempt: attemptIndex + 2
        });
        await runFixedActionChunk({
          actions: createFixedSocialTalkActions({
            includeAcquire: false,
            idPrefix: `fixed-social-recovery-talk-${attemptIndex + 1}`
          }),
          options,
          plan,
          perceptionSummary,
          commentaryText: getFixedStageProgressText(stage.key, roundNumber, "talk"),
          executions
        });
        return {
          ...mergeWorkerExecutions(executions),
          outcomeKind: "recovered"
        };
      } catch (retryError) {
        if (!isRecoverableSocialFailure(retryError)) {
          throw retryError;
        }
        lastError = retryError;
      }
    }

    throw annotateFailureAttemptMetadata(lastError, {
      attemptCount: SOCIAL_RETARGET_BUDGET,
      attemptBudget: SOCIAL_RETARGET_BUDGET
    });
  }
}

async function runFixedDarkCloseStageExecution({
  roundNumber,
  plan,
  perceptionSummary,
  externalInputGuardEnabled = true
}) {
  const executions = [];
  const actions = createFixedDarkCloseStageActions();
  const options = {
    interruptOnExternalInput: externalInputGuardEnabled
  };
  const isRestartableDarkFailure = (error) => ["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(getFailureCode(error));

  try {
    await runFixedActionChunk({
      actions: actions.slice(0, 4),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageProgressText("dark_close", roundNumber, "stealth"),
      executions
    });
    await runFixedActionChunk({
      actions: actions.slice(4, 7),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageProgressText("dark_close", roundNumber, "drag"),
      executions
    });
    let lootFailure = null;
    try {
      await runFixedActionChunk({
        actions: actions.slice(7),
        options,
        plan,
        perceptionSummary,
        commentaryText: getFixedStageProgressText("dark_close", roundNumber, "loot"),
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
        appendFixedScriptCommentary({
          text: "刚才那一下动静有点大，我先换个更顺手的角度，再把这趟活补回来。",
          plan,
          perceptionSummary
        });
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
  const isRestartableDarkFailure = (error) => ["STEALTH_ALERTED", "STEALTH_TARGET_RECOVERED"].includes(getFailureCode(error));

  try {
    await runFixedActionChunk({
      actions: actions.slice(0, 4),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageProgressText("dark_miaoqu", roundNumber, "setup"),
      executions
    });
    await runFixedActionChunk({
      actions: actions.slice(4, 5),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageProgressText("dark_miaoqu", roundNumber, "panel"),
      executions
    });
    await runFixedActionChunk({
      actions: actions.slice(5),
      options,
      plan,
      perceptionSummary,
      commentaryText: getFixedStageProgressText("dark_miaoqu", roundNumber, "escape"),
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
    for (let attemptIndex = 0; attemptIndex < DARK_CLOSE_RESTART_BUDGET; attemptIndex += 1) {
      try {
        appendFixedScriptCommentary({
          text: "刚才那一下不够干净，我换个身位再摸，不跟原地那点运气硬赌。",
          plan,
          perceptionSummary
        });
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
    }

    throw annotateFailureAttemptMetadata(lastError, {
      attemptCount: DARK_CLOSE_RESTART_BUDGET,
      attemptBudget: DARK_CLOSE_RESTART_BUDGET
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
  const localOpenTradeActions = createFixedEndingTradeOpenTradeActions({
    idPrefix: "fixed-ending-trade-local"
  });
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

  appendFixedScriptCommentary({
    text: getFixedStageProgressText("ending_trade", roundNumber, "target"),
    plan,
    perceptionSummary
  });
  let openTradeExecution = null;
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    try {
      openTradeExecution = await runWindowsActions(localOpenTradeActions, options);
      executions.push(openTradeExecution);
      break;
    } catch (error) {
      // Keep the local retry silent; only after two misses do we reroute to the safer street spot.
    }
  }

  if (!openTradeExecution) {
    try {
      openTradeExecution = await runWindowsActions(relocatedOpenTradeActions, options);
      executions.push(openTradeExecution);
    } catch (error) {
      throw error;
    }
  }

  await runFixedActionChunk({
    actions: tradeBundleActions.slice(0, 5),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageProgressText("ending_trade", roundNumber, "trade"),
    executions
  });
  await runFixedActionChunk({
    actions: tradeBundleActions.slice(5),
    options,
    plan,
    perceptionSummary,
    commentaryText: getFixedStageProgressText("ending_trade", roundNumber, "finish"),
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
    thinkingChain: plan.thinkingChain,
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
  if (!context?.workerActions?.length) {
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
    if (context.recoveryKind === "npc_reply_loop") {
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
        recoveryKind: context.recoveryKind || "npc_reply_loop",
        replyResultOverride: replyResult || null,
        skipExecutionRecording: true
      });
    } else {
      const execution = await runWindowsActions(context.workerActions, {
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
        recoveryKind: context.recoveryKind || "worker_actions"
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
    throw error;
  } finally {
    turnInFlight = false;
  }
}

async function runPlannedTurn({
  instruction,
  scene,
  perception,
  source,
  interactionMode = "act",
  externalInputGuardEnabled = true,
  perceptionSummary = perceptionSummaryBySource(perception, source)
}) {
  const runtimeBefore = getState();

  appendMessage(buildUserMessage({
    instruction,
    scene,
    perception,
    origin: source
  }));
  appendLog("info", source === "agent" ? `自主目标开始：${instruction}` : `收到对话输入：${instruction}`, {
    instruction,
    scene,
    source,
    interactionMode
  });

  updateAgent({
    mode: source === "user" ? "user_priority" : "autonomous",
    phase: source === "user" ? "user_priority" : "autonomous",
    currentObjective: instruction,
    queuedUserObjective: source === "user" ? instruction : null,
    lastUserInstruction: source === "user" ? instruction : runtimeBefore.agent.lastUserInstruction,
    lastAutonomousInstruction: source === "agent" ? instruction : runtimeBefore.agent.lastAutonomousInstruction
  });

  const nextState = getState();
  const plan = await createTurnPlan({
    instruction,
    scene,
    conversationMessages: nextState.messages.slice(0, -1),
    perception
  });

  let execution;
  if (interactionMode === "watch") {
    execution = {
      executor: "WatchMode",
      steps: [],
      rawSteps: [],
      durationMs: 0,
      outcome: "当前处于观看模式，本轮只观察屏幕并和籽岷互动，不执行动作。"
    };
  } else {
    try {
      execution = await runWindowsExecution(plan, {
        interruptOnExternalInput: interactionMode === "act" && externalInputGuardEnabled
      });
    } catch (error) {
      const failedExecution = {
        rawSteps: Array.isArray(error.workerPayload?.steps) ? error.workerPayload.steps : [],
        durationMs: error.durationMs || null
      };

      await recordMotionReviewSamples({
        instruction,
        source,
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });

      await recordInteractionLearningSample({
        instruction,
        source,
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });
      throw error;
    }

    await recordMotionReviewSamples({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution
    });

    await recordInteractionLearningSample({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution
    });

    const replyResult = await maybeSendNpcReply({
      instruction,
      plan,
      execution,
      externalInputGuardEnabled
    });

    if (replyResult) {
      execution = {
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
        outcome: `${execution.outcome} 已自动续聊 ${replyResult.rounds.length} 轮 NPC 对话。`,
        replyText: replyResult.replyText,
        replyRounds: replyResult.rounds
      };
    }
  }

  const turn = {
    id: `turn-${Date.now()}`,
    instruction,
    scene,
    createdAt: new Date().toISOString(),
    source,
    interactionMode,
    externalInputGuardEnabled,
    plan,
    execution,
    perception: perception || null
  };

  setCurrentTurn(turn);

  appendLog("info", "意图解析完成", {
    intent: plan.intent,
    strategy: plan.selectedStrategy,
    source
  });
  appendLog("info", "执行器返回结果", {
    actionCount: plan.actions.length,
    riskLevel: plan.riskLevel,
    source
  });
  appendLog("info", interactionMode === "watch" ? "前台已切到观看模式" : "前台已切到行动模式", {
    interactionMode,
    source
  });
  appendLog("info", "\u6267\u884c\u5668\u8fd4\u56de\u7ed3\u679c", {
    executor: execution.executor,
    outcome: execution.outcome,
    source
  });

  if (plan.fallbackReason) {
    appendLog("warn", "本轮使用了回退规划", {
      reason: plan.fallbackReason,
      source
    });
  }

  appendAssistantPlanMessage({
    plan,
    execution,
    perceptionSummary
  });

  appendExperiment(buildExperimentRecord({
    instruction,
    source,
    scene,
    plan,
    execution,
    perception,
    perceptionSummary
  }));

  const agentBeforeUpdate = getState().agent;
  updateAgent({
    mode: "autonomous",
    phase: source === "user" ? "cooldown" : "autonomous",
    currentObjective: interactionMode === "watch" ? "watch" : plan.selectedStrategy,
    queuedUserObjective: source === "user" ? null : agentBeforeUpdate.queuedUserObjective,
    lastTurnSource: source,
    lastTurnAt: new Date().toISOString(),
    autonomousTurnCount: source === "agent"
      ? agentBeforeUpdate.autonomousTurnCount + 1
      : agentBeforeUpdate.autonomousTurnCount
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
      await maybeRunWatchCommentaryTurn(runtimeState);
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
      if (automation.status === "armed" || automation.status === "running") {
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
          status: automation.startedAt ? "running" : "armed"
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
    const nextState = await runPlannedTurn({
      instruction,
      scene,
      perception: state.latestPerception,
      source: "user",
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
    appendMessage({
      role: "assistant",
      text: `这轮实验失败了：${error.message}`,
      thinkingChain: [],
      recoveryLine: "我先承认这轮没控住，接下来会先保住上下文再补救。",
      perceptionSummary: "这一轮没有稳定产出可用结果。",
      sceneLabel: "执行失败",
      riskLevel: "high",
      actions: []
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
    const text = await transcribeWithLocalWhisper({
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

async function handleChat(request, response) {
  const body = await readRequestBody(request);
  const instruction = String(body.instruction || "").trim();
  const automationTriggered = hasAutomationTrigger(instruction);
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

  if (automationTriggered) {
    armAutomationScript(instruction);
    appendLog("info", "固定剧本自动化已布置", {
      instruction,
      startsAt: getState().automation.startsAt,
      triggerWord: "加油"
    });
    appendMessage({
      role: "assistant",
      text: "收到加油啦！马上动脑筋～",
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
      triggerWord: "加油"
    });
    appendMessage({
      role: "assistant",
      text: "收到加油啦！马上动脑筋～",
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

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, response);
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
