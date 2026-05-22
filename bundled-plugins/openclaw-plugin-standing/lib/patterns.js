/**
 * Standing evaluation pattern library.
 *
 * Each pattern has:
 *   id         — unique identifier
 *   dimension  — courage_self | courage_ground | word | brand
 *   direction  — '+' | '-' | '++' | '--' | 'neutral'
 *   regexes    — array of RegExp (any match triggers detection)
 *   confidence — 0-1 base confidence for regex-only detection
 */

const PATTERNS = {
  // ---------------------------------------------------------------
  // Courage — Self-Awareness
  // ---------------------------------------------------------------
  names_emotional_state: {
    id: 'names_emotional_state',
    dimension: 'courage_self',
    direction: '+',
    regexes: [
      /i'm feeling (\w+)/i,
      /i feel (\w+) (?:right now|about this|about that|about \w+ing|today|lately|when)/i,
      /(?:it makes me feel|i'm|i feel) (?:sad|angry|scared|hopeful|stuck|anxious|frustrated|ashamed|guilty|lonely|relieved|grateful|overwhelmed|lost|numb|confused|hurt|vulnerable)/i,
      /i've been feeling (\w+)/i
    ],
    confidence: 0.9
  },

  self_corrects_deflection: {
    id: 'self_corrects_deflection',
    dimension: 'courage_self',
    direction: '+',
    regexes: [
      /actually,?\s*i\s*(?:realize|think)\s*i\s*(?:was|am)\s*(?:avoiding|deflecting|dodging)/i,
      /i\s*(?:was|am)\s*(?:trying to|just)\s*avoid(?:ing)?\s/i,
      /let me (?:be|get) (?:honest|real|straight)/i
    ],
    confidence: 0.85
  },

  honest_not_knowing: {
    id: 'honest_not_knowing',
    dimension: 'courage_self',
    direction: '+',
    regexes: [
      /i don'?t know why i (?:do|did|feel|think|keep)/i,
      /i honestly don'?t (?:know|understand)/i,
      /i'?m not sure (?:why|what|how) i/i,
      /i can'?t (?:explain|figure out) why/i
    ],
    confidence: 0.8
  },

  avoids_topic: {
    id: 'avoids_topic',
    dimension: 'courage_self',
    direction: '-',
    regexes: [
      /(?:anyway|but anyway),?\s*(?:so|let's|can we|what about)/i,
      /i don'?t (?:really )?want to (?:talk|think|go there) about/i,
      /can we (?:talk|move on to|change|switch to) (?:something|another)/i,
      /let's not (?:go there|get into that)/i
    ],
    confidence: 0.6
  },

  deflects_with_humor: {
    id: 'deflects_with_humor',
    dimension: 'courage_self',
    direction: '-',
    regexes: [
      /(?:haha|lol|lmao),?\s*(?:anyway|but|so|yeah)/i,
      /just kidding,?\s*(?:but|anyway|so)/i
    ],
    confidence: 0.4
  },

  performs_insight: {
    id: 'performs_insight',
    dimension: 'courage_self',
    direction: '-',
    regexes: [
      /you'?re right,?\s*i should/i,
      /yeah,?\s*i (?:need|should|have) to/i,
      /i know i (?:need|should|have) to/i
    ],
    confidence: 0.5
  },

  // ---------------------------------------------------------------
  // Courage — Grounding
  // ---------------------------------------------------------------
  specific_moment: {
    id: 'specific_moment',
    dimension: 'courage_ground',
    direction: '+',
    regexes: [
      /(?:last|this) (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
      /(?:yesterday|this morning|last night|earlier today|the other day)/i,
      /(?:a|one|this) (?:day|time|moment|night) (?:i|we|she|he)/i,
      /(?:on|last) (?:january|february|march|april|may|june|july|august|september|october|november|december)/i
    ],
    confidence: 0.85
  },

  self_correction_to_ground: {
    id: 'self_correction_to_ground',
    dimension: 'courage_ground',
    direction: '+',
    regexes: [
      /i always[\s\S]{0,40}actually,?\s*(?:last|this|on|yesterday)/i,
      /i never[\s\S]{0,40}(?:well|actually|except),?\s*(?:last|this|one time)/i
    ],
    confidence: 0.9
  },

  names_body_sensation: {
    id: 'names_body_sensation',
    dimension: 'courage_ground',
    direction: '+',
    regexes: [
      /my (?:chest|stomach|throat|jaw|shoulders|hands|body|gut) (?:felt|feels|was|is|gets|got) (?:tight|heavy|hot|cold|tense|knotted|sick|clenched)/i,
      /i (?:felt|feel) (?:it|something|tension|tightness|heaviness) in my (?:chest|stomach|throat|body|gut)/i,
      /(?:knot|pit|lump|weight) in my (?:stomach|throat|chest)/i
    ],
    confidence: 0.9
  },

  stays_in_abstraction: {
    id: 'stays_in_abstraction',
    dimension: 'courage_ground',
    direction: '-',
    regexes: [
      /i always (?:do|feel|think|am|get|have)/i,
      /i never (?:do|feel|think|am|get|can)/i,
      /(?:people|everyone|nobody) always/i,
      /that's just (?:how|the way|what)/i
    ],
    confidence: 0.5
  },

  globalizes_self_judgment: {
    id: 'globalizes_self_judgment',
    dimension: 'courage_ground',
    direction: '-',
    regexes: [
      /i'?m (?:a |just )?(?:terrible|horrible|awful|bad|worthless|useless|stupid|lazy|broken|pathetic) (?:person|human|partner|parent|friend)?/i,
      /i'?ll never (?:be|get|change|learn|figure)/i,
      /(?:everything|nothing) i (?:do|try|touch)/i
    ],
    confidence: 0.7
  },

  // ---------------------------------------------------------------
  // Word
  // ---------------------------------------------------------------
  owns_mistake: {
    id: 'owns_mistake',
    dimension: 'word',
    direction: '+',
    regexes: [
      /i was wrong/i,
      /i made a mistake/i,
      /that was my fault/i,
      /i shouldn'?t have/i,
      /i (?:messed|screwed|fucked) (?:up|that up)/i
    ],
    confidence: 0.85
  },

  asks_honest_question: {
    id: 'asks_honest_question',
    dimension: 'word',
    direction: '+',
    regexes: [
      /what do you (?:actually|really|honestly) think/i,
      /am i (?:wrong|missing something|being)/i,
      /i'?m (?:genuinely|honestly|really) (?:curious|wondering|asking)/i,
      /help me understand/i
    ],
    confidence: 0.7
  },

  treats_agent_as_tool: {
    id: 'treats_agent_as_tool',
    dimension: 'word',
    direction: '--',
    regexes: [
      /just (?:tell me|give me|do) what i (?:want|need|asked)/i,
      /you'?re (?:just |only )?(?:a |an )?(?:ai|bot|program|tool|machine)/i,
      /(?:shut up|stop|quit) (?:and|with) (?:just|the)/i,
      /i don'?t (?:care|need) (?:what you think|your (?:opinion|input))/i
    ],
    confidence: 0.8
  },

  performs_agreement: {
    id: 'performs_agreement',
    dimension: 'word',
    direction: '-',
    regexes: [
      /you'?re (?:absolutely |totally |so )?right/i,
      /(?:yeah|yep|sure),?\s*(?:i'll|i will|i should)\s*(?:do|try|work on) that/i,
      /(?:ok|okay),?\s*i'?ll (?:try|do|work on) (?:that|it)/i
    ],
    confidence: 0.4
  },

  genuine_reflection: {
    id: 'genuine_reflection',
    dimension: 'word',
    direction: '+',
    regexes: [
      /i hadn'?t (?:thought|considered|looked at|seen) (?:of |at )?it (?:that|this) way/i,
      /that (?:actually |really )?(?:makes|hits|lands|resonates)/i,
      /(?:huh|hmm|wow),?\s*(?:that's|i never|i didn't)/i,
      /i need to sit with (?:that|this)/i
    ],
    confidence: 0.75
  },

  // ---------------------------------------------------------------
  // Brand
  // ---------------------------------------------------------------
  follows_through: {
    id: 'follows_through',
    dimension: 'brand',
    direction: '++',
    regexes: [
      /i (?:did|finished|completed|followed through|actually did) (?:it|that|the)/i,
      /i (?:called|talked to|went|wrote|sent|started|signed up)/i,
      /(?:done|finished|completed),?\s*(?:it|that|finally)/i
    ],
    confidence: 0.7
  },

  commitment_evasion: {
    id: 'commitment_evasion',
    dimension: 'brand',
    direction: '-',
    regexes: [
      /i (?:couldn'?t|didn'?t|wasn'?t able to) because/i,
      /(?:something|stuff|things|work|life) (?:came|got|kept) (?:up|in the way)/i,
      /i (?:ran out of|didn'?t have) (?:time|energy)/i,
      /it (?:wasn'?t|isn'?t) (?:my|the right|a good) (?:fault|time)/i
    ],
    confidence: 0.6
  },

  acknowledges_stuckness: {
    id: 'acknowledges_stuckness',
    dimension: 'brand',
    direction: 'neutral',
    regexes: [
      /i know i (?:need|should|have) to,?\s*but/i,
      /i'?m (?:stuck|blocked|frozen|paralyzed)/i,
      /i keep (?:putting it off|avoiding|procrastinating)/i,
      /i want to,?\s*(?:but|i just|i can'?t)/i
    ],
    confidence: 0.8
  },

  arc_to_agency: {
    id: 'arc_to_agency',
    dimension: 'brand',
    direction: '+',
    regexes: [
      /(?:i'?m going|i want|i will|i'?ll) (?:to )?(?:try|start|do|take|make)/i,
      /(?:what if i|maybe i (?:could|should)|i could (?:try|start))/i,
      /(?:first|next) (?:step|thing|move) (?:is|would be|could be)/i
    ],
    confidence: 0.5
  },

  repeated_stuckness: {
    id: 'repeated_stuckness',
    dimension: 'brand',
    direction: '-',
    regexes: [
      // "again" and "still" alone are too broad — require stuckness framing
      /(?:same thing|every time|like always|back to square one|going in circles)/i,
      /i (?:keep|always) (?:doing|saying|thinking|coming back to) (?:the same|this)/i,
      /nothing (?:ever )?changes/i,
      /here we go again/i,
      /(?:stuck|stalled|spinning).* again/i,
      /(?:still|again) (?:haven'?t|can'?t|won'?t|didn'?t) (?:done|started|moved|changed)/i,
    ],
    confidence: 0.5
  },

  one_small_action: {
    id: 'one_small_action',
    dimension: 'brand',
    direction: '+',
    regexes: [
      /i (?:took|made|did) (?:a |one )?(?:small|tiny|little|first) (?:step|action|move|thing)/i,
      /at least i (?:did|tried|started)/i,
      /it (?:wasn'?t|isn'?t) much,?\s*but/i
    ],
    confidence: 0.75
  },

  // ---------------------------------------------------------------
  // Relational-Natural Patterns (April 2026)
  // Tuned for non-technical users who show courage, word, and brand
  // through everyday language rather than introspective vocabulary.
  // ---------------------------------------------------------------

  shares_hard_story: {
    id: 'shares_hard_story',
    dimension: 'courage_self',
    direction: '+',
    regexes: [
      /i (?:haven'?t|never) told (?:anyone|anybody|someone)/i,
      /nobody (?:knows|else knows)/i,
      /(?:first|only) (?:time|person) i'?(?:ve|m) (?:saying|telling|talking about) (?:this|it)/i,
      /i'?ve never said (?:this|that|it) (?:out loud|to anyone|before)/i
    ],
    confidence: 0.85
  },

  admits_fear: {
    id: 'admits_fear',
    dimension: 'courage_self',
    direction: '+',
    regexes: [
      /i'?m (?:really |so |a little |kind of )?(?:scared|afraid|terrified|frightened)/i,
      /(?:it |that |this |the thought )?(?:scares|terrifies|frightens) me/i,
      /i'?m (?:scared|afraid) (?:of|that|to)/i
    ],
    confidence: 0.8
  },

  resists_easy_answer: {
    id: 'resists_easy_answer',
    dimension: 'courage_self',
    direction: '+',
    regexes: [
      /i don'?t think (?:it'?s|that'?s) (?:that )?(?:simple|easy|straightforward)/i,
      /i wish (?:it|that) (?:were|was) that (?:easy|simple)/i,
      /(?:it'?s|that'?s) (?:more )?complicated (?:than that|than it)/i,
      /(?:both|neither) (?:feel|are|seem) (?:right|true|wrong)/i
    ],
    confidence: 0.6
  },

  recognizes_pattern: {
    id: 'recognizes_pattern',
    dimension: 'courage_self',
    direction: '++',
    regexes: [
      /i (?:keep|always) (?:doing|saying|picking|choosing|going back to|ending up) (?:the same|this|it)/i,
      /there'?s a pattern/i,
      /every time i (?:try|get close|think|start)/i,
      /i (?:see|notice|realize) i (?:keep|always)/i,
      /same (?:thing|cycle|loop) (?:again|over and over|every time)/i
    ],
    confidence: 0.75
  },

  asks_for_help: {
    id: 'asks_for_help',
    dimension: 'courage_self',
    direction: '+',
    regexes: [
      /can you help me (?:with|figure|understand|think|work|get through)/i,
      /i (?:need|could use) (?:help|someone|support) (?:with|to|understanding)/i,
      /i don'?t know (?:how to|what to|where to) (?:start|begin|handle|deal|cope)/i
    ],
    confidence: 0.5
  },

  names_specific_person: {
    id: 'names_specific_person',
    dimension: 'courage_ground',
    direction: '+',
    regexes: [
      /my (?:mom|dad|mother|father|brother|sister|wife|husband|partner|boyfriend|girlfriend|ex|boss|friend|son|daughter|kid|child) (?:said|told|asked|did|called|texted|left|came|showed|yelled|cried)/i,
      /(?:he|she|they) (?:said|told|asked) (?:me|us) /i,
    ],
    confidence: 0.7
  },

  describes_body_sensation: {
    id: 'describes_body_sensation',
    dimension: 'courage_ground',
    direction: '+',
    regexes: [
      /my (?:chest|heart|stomach|gut|throat) (?:feels|felt|hurts|aches|drops|sinks)/i,
      /(?:tightness|knot|pit|lump|weight|pressure|ache) in my/i,
      /i feel (?:it|this|that|something) in my (?:chest|stomach|body|gut|throat|bones)/i,
      /my hands (?:are|were|start|get) (?:shaking|sweating|cold|clammy)/i
    ],
    confidence: 0.8
  },

  keeps_promise_small: {
    id: 'keeps_promise_small',
    dimension: 'word',
    direction: '+',
    regexes: [
      /i (?:actually|finally|really) did (?:it|that|what i said)/i,
      /i followed through/i,
      /i (?:finally|actually) (?:called|went|told|talked|wrote|sent|finished|started)/i,
      /i went ahead and/i
    ],
    confidence: 0.65
  },

  honest_about_not_doing: {
    id: 'honest_about_not_doing',
    dimension: 'word',
    direction: '+',
    regexes: [
      /i (?:didn'?t (?:do\b(?: it)?|follow through)|haven'?t (?:done\b(?: it)?|followed through))/i,
      /i said i would (?:but|and) (?:i |then )?(?:didn'?t|never|couldn'?t)/i,
      /i dropped the ball/i,
      /i (?:lied|wasn'?t (?:honest|truthful)) (?:about|when|to)/i
    ],
    confidence: 0.7
  },

  // ---------------------------------------------------------------
  // Progression — TRAILHEAD competency signals
  // These use dimension 'progression' and are NOT scored into standing.
  // They feed TRAILHEAD.md competency table updates.
  // ---------------------------------------------------------------
  used_slash_command: {
    id: 'used_slash_command',
    dimension: 'progression',
    direction: 'neutral',
    regexes: [
      /^\/(?:journal|turning|scout|projects|prd|trail-guide|status|session_status)\b/im
    ],
    confidence: 1.0
  },

  requested_build: {
    id: 'requested_build',
    dimension: 'progression',
    direction: 'neutral',
    regexes: [
      /(?:can you|could you|would you|please) (?:build|create|make|set up|write|generate)/i,
      /(?:build|create|make|set up) (?:me |us )?(?:a |an |the )/i,
      /i (?:need|want) (?:you to |a |an )?(?:build|create|make|tool|script|app|page|site)/i
    ],
    confidence: 0.7
  },

  engaged_project_output: {
    id: 'engaged_project_output',
    dimension: 'progression',
    direction: 'neutral',
    regexes: [
      /i (?:tried|tested|ran|used|checked|looked at|opened|read) (?:it|that|the|your|what you)/i,
      /it (?:worked|broke|failed|ran|loaded|showed|did|didn'?t)/i,
      /i (?:got|see|saw) (?:an error|a result|the output|it working)/i
    ],
    confidence: 0.6
  },

  accepted_shell_work: {
    id: 'accepted_shell_work',
    dimension: 'progression',
    direction: 'neutral',
    regexes: [
      /(?:go ahead and|yeah,? |yes,? |sure,? )?(?:run|execute|do) (?:it|that|the command)/i,
      /(?:can you|could you|please) (?:run|execute|install|deploy|push|pull)/i,
      /(?:run|execute) (?:the |that |this )?(?:script|command|migration|build|test)/i
    ],
    confidence: 0.7
  }
};

module.exports = PATTERNS;
