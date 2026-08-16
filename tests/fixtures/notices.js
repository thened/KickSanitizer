// KickSanitizer — notice fixtures captured from live Kick.com, 2026-08-16.
//
// Loaded as plain JS (not fetched HTML) so tests stay synchronous and work
// from file:// with no server and no CORS.
//
// Provenance:
//   giftedSubs   — kick.com/channelB, verbatim capture (badge SVG paths elided)
//   subscription — kick.com/channelD, verbatim capture
//   kicks        — kick.com/channelA, reassembled from captured attributes;
//                  badge <svg> internals elided. Structure/attrs are verbatim.
//
// Key fact: Kicks has NO native notice row. Kick posts it as an ordinary
// ChatMessageEvent from the official KickBot account (user id 4377088), so the
// row is structurally identical to any user message.

window.KS_FIXTURES = window.KS_FIXTURES || {};

window.KS_FIXTURES.notices = {

  // Native notice card — gifted subs. One [data-index] holds MANY cards:
  // a summary card plus one card per recipient, wrapped in div.flex.flex-col.gap-1
  giftedSubs: `
<div data-index="50" class="absolute inset-x-0 top-0" style="transform: translateY(2070px);">
  <div class="flex flex-col gap-1">
    <div class="px-px" style="font-size: var(--chatroom-font-size);">
      <div class="relative box-border flex flex-row gap-2 rounded-r border-l-4 bg-surface-base p-4"
           style="border-color: rgb(255, 196, 102);">
        <svg data-ds-icon="Gift50" width="20" height="20" viewBox="0 0 20 20" fill="none"
             class="inline-block size-6 shrink-0 grow-0"></svg>
        <div class="flex grow flex-col">
          <button class="inline self-baseline leading-6 font-bold">Gifter1</button>
          <span class="text-surface-onSurfaceSecondary" style="font-size: calc(100% - 1px);">Gifted <span>50</span> subscriptions to the community! They've gifted <span>150 subscriptions</span> in the channel.</span>
        </div>
      </div>
    </div>
    <div class="px-px" style="font-size: var(--chatroom-font-size);">
      <div class="relative box-border flex flex-row gap-2 rounded-r border-l-4 bg-surface-base p-4"
           style="border-color: rgb(255, 196, 102);">
        <div class="flex size-6 shrink-0 grow-0 flex-row justify-center">
          <svg data-ds-icon="Gift" width="20" height="20" viewBox="0 0 20 20" fill="none"
               class="inline-block shrink-0 my-auto size-4" style="color: rgb(255, 196, 102);"></svg>
        </div>
        <span class="leading-6 text-surface-onSurfaceSecondary" style="font-size: calc(100% - 1px);"><button class="inline font-bold text-white">Gifter1</button> gifted a sub to <button class="inline font-bold text-white">Recipient1</button></span>
      </div>
    </div>
    <div class="px-px" style="font-size: var(--chatroom-font-size);">
      <div class="relative box-border flex flex-row gap-2 rounded-r border-l-4 bg-surface-base p-4"
           style="border-color: rgb(255, 196, 102);">
        <div class="flex size-6 shrink-0 grow-0 flex-row justify-center">
          <svg data-ds-icon="Gift" width="20" height="20" viewBox="0 0 20 20" fill="none"
               class="inline-block shrink-0 my-auto size-4" style="color: rgb(255, 196, 102);"></svg>
        </div>
        <span class="leading-6 text-surface-onSurfaceSecondary" style="font-size: calc(100% - 1px);"><button class="inline font-bold text-white">Gifter1</button> gifted a sub to <button class="inline font-bold text-white">Recipient2</button></span>
      </div>
    </div>
  </div>
</div>`.trim(),

  // Native notice card — plain subscription. NOTE: no .flex.flex-col.gap-1
  // wrapper; the card sits directly under [data-index]. Accent is Kick green.
  subscription: `
<div data-index="25" class="absolute inset-x-0 top-0" style="transform: translateY(805px);">
  <div class="px-px" style="font-size: var(--chatroom-font-size);">
    <div class="relative box-border flex flex-row gap-2 rounded-r border-l-4 bg-surface-base p-4"
         style="border-color: rgb(83, 252, 24);">
      <svg data-ds-icon="SparkleFilled" width="20" height="20" viewBox="0 0 20 20" fill="none"
           class="inline-block size-6 shrink-0 grow-0" style="color: rgb(83, 252, 24);"></svg>
      <div class="flex flex-col gap-0.5">
        <span class="text-surface-onSurfaceSecondary" style="font-size: calc(100% - 1px);"><button class="flex w-fit font-bold text-white" style="font-size: var(--chatroom-font-size);">Subscriber1</button> has subscribed! They have been subscribed for a total of <span>1</span> month.</span>
      </div>
    </div>
  </div>
</div>`.trim(),

  // Kicks — NOT a notice card. Ordinary chat row posted by KickBot.
  kicks: `
<div data-index="19" class="absolute inset-x-0 top-0" style="transform: translateY(1570px);">
  <div class="group relative px-2 lg:px-3">
    <div class="w-full min-w-0 shrink-0 rounded-lg px-2 break-words betterhover:group-hover:bg-surface-highest"
         style="font-size: var(--chatroom-font-size); padding-block: var(--chatroom-message-spacing);">
      <span class="text-neutral pr-1 font-semibold">12:56 PM</span>
      <div class="inline-flex min-w-0 flex-nowrap items-baseline rounded cursor-pointer">
        <div class="flex items-center gap-1 self-center pr-1">
          <div data-testid="identity-badge-moderator" class="inline-flex shrink-0 items-center justify-center"></div>
          <div data-testid="identity-badge-verified" class="inline-flex shrink-0 items-center justify-center"></div>
        </div>
        <button class="inline font-bold" data-prevent-expand="true" style="color: rgb(233, 17, 60);">KickBot</button>
      </div>
      <span class="font-normal leading-[1.55]">@Viewer1 just gifted 50 KICKs!</span>
    </div>
  </div>
</div>`.trim(),

  // Follow announcement. DERIVED, not captured: Kick has no native follow
  // notice — a chat bot posts it, so the row is an ordinary message. The
  // structure below is the verified KickBot chat-row shape with the sender and
  // text swapped. Replace with a verbatim capture when one is available.
  followByBot: `
<div data-index="12" class="absolute inset-x-0 top-0">
  <div class="group relative px-2 lg:px-3">
    <div class="w-full min-w-0 shrink-0 rounded-lg px-2 break-words betterhover:group-hover:bg-surface-highest">
      <span class="text-neutral pr-1 font-semibold">12:58 PM</span>
      <div class="inline-flex min-w-0 flex-nowrap items-baseline rounded cursor-pointer">
        <button class="inline font-bold" data-prevent-expand="true">Botrix</button>
      </div>
      <span class="font-normal leading-[1.55]">Subscriber1 just followed the channel!</span>
    </div>
  </div>
</div>`.trim(),

  // Ordinary user message, for negative assertions
  normal: `
<div data-index="7" class="absolute inset-x-0 top-0">
  <div class="group relative px-2 lg:px-3">
    <div class="w-full min-w-0 shrink-0 rounded-lg px-2 break-words betterhover:group-hover:bg-surface-highest">
      <span class="text-neutral pr-1 font-semibold">12:47 PM</span>
      <div class="inline-flex min-w-0 flex-nowrap items-baseline rounded cursor-pointer">
        <button class="inline font-bold" data-prevent-expand="true">Viewer2</button>
      </div>
      <span class="font-normal leading-[1.55]">ive never been more adrenaline at my computer</span>
    </div>
  </div>
</div>`.trim(),
};

// Raw socket payload for the Kicks event (channel_{id}, underscore form).
window.KS_FIXTURES.kicksGiftedEvent = {
  gift_transaction_id: '9578013a-723f-4069-9fd2-a9444eb82cdd',
  message: '',
  sender: { id: 100000001, username: 'Viewer1', username_color: '#6F87FF' },
  gift: { gift_id: 'hype', name: 'Hype', amount: 10, type: 'BASIC', tier: 'BASIC',
          character_limit: 0, pinned_time: 0 },
  created_at: '2026-08-16T04:00:56.792548201Z',
};

// Helper: turn a fixture string into the element the filters actually receive
// (the child of [data-index], matching KS.Sel.chatMessage).
window.KS_FIXTURES.mount = function (html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  const row = host.firstElementChild;          // [data-index]
  return row.firstElementChild || row;         // what chatMessage selects
};
