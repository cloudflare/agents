import { ChatBubble } from "./chat-bubble";
import { AiLogo, CallsLogo, MagicLogo, PagesLogo, WorkersLogo } from "./icons";

export function FooterVisual() {
  return (
    <div className="flex justify-center overflow-hidden">
      <div className="w-[1400px] h-[200px] mx-auto flex justify-center items-end overflow-hidden relative">
        <div className="-translate-y-[46px]">
          <div className="translate-y-[70px]">
            <ChatBubble>
              <div className="space-y-1">
                <div className="bg-orange-100 h-[1em] w-[200px]" />
                <div className="bg-orange-100 h-[1em] w-[150px]" />
              </div>
            </ChatBubble>
          </div>
          <div
            className="absolute"
            style={{
              translate: "297px -79px",
              rotate: "39deg"
            }}
          >
            <div className="w-16 h-16 bg-white border border-orange-400 rounded-full text-orange-400 flex items-center justify-center">
              <AiLogo width={40} />
            </div>
          </div>
          <div
            className="absolute"
            style={{
              translate: "126px -56px",
              rotate: "150deg"
            }}
          >
            <div className="w-14 h-14 bg-white border border-orange-400 rounded-full text-orange-400 flex items-center justify-center">
              <AiLogo width={32} />
            </div>
          </div>
          <div
            className="absolute"
            style={{
              translate: "53px -70px",
              rotate: "332deg"
            }}
          >
            <div className="p-[2px] flex items-center justify-center border border-orange-400 rounded-full border-dashed">
              <div className="w-16 h-16 border bg-white rounded-full text-orange-400 flex items-center justify-center">
                <WorkersLogo width={40} />
              </div>
            </div>
          </div>
          <div
            className="absolute"
            style={{
              translate: "-566px -24px",
              rotate: "46deg"
            }}
          >
            <div className="p-[2px] flex items-center justify-center border border-orange-400 border-dashed rounded-full">
              <div className="w-16 h-16 border bg-white rounded-full text-orange-400 flex items-center justify-center">
                <PagesLogo width={36} />
              </div>
            </div>
          </div>
          <div
            className="absolute"
            style={{
              translate: "-129px -86px",
              rotate: "341deg"
            }}
          >
            <div className="p-[2px] flex items-center justify-center border border-orange-400 border-dashed rounded-full">
              <div className="w-16 h-16 border bg-white rounded-full text-orange-400 flex items-center justify-center">
                <CallsLogo width={36} />
              </div>
            </div>
          </div>
          <div
            className="absolute"
            style={{
              translate: "468px -102px"
            }}
          >
            <div className="p-[2px] flex items-center justify-center border border-orange-400 border-dashed rounded-full">
              <div className="w-16 h-16 border bg-white rounded-full text-orange-400 flex items-center justify-center">
                <MagicLogo width={36} />
              </div>
            </div>
          </div>
          <div
            className="absolute"
            style={{
              translate: "170px -30px",
              rotate: "39deg"
            }}
          >
            <ChatBubble>
              <div className="space-y-1">
                <div className="bg-orange-100 h-[1em] w-[200px]" />
                <div className="bg-orange-100 h-[1em] w-[150px]" />
              </div>
            </ChatBubble>
          </div>
          <div
            className="absolute"
            style={{
              translate: "-170px -30px",
              rotate: "140deg"
            }}
          >
            <ChatBubble>
              <div className="space-y-1">
                <div className="bg-orange-100 h-[1em] w-[200px]" />
                <div className="bg-orange-100 h-[1em] w-[150px]" />
              </div>
            </ChatBubble>
          </div>
          <div
            className="absolute"
            style={{
              translate: "-355px -30px",
              rotate: "350deg"
            }}
          >
            <ChatBubble>
              <div className="space-y-1">
                <div className="bg-orange-100 h-[1em] w-[200px]" />
                <div className="bg-orange-100 h-[1em] w-[150px]" />
              </div>
            </ChatBubble>
          </div>
          <div
            className="absolute"
            style={{
              translate: "355px -36px",
              rotate: "188deg"
            }}
          >
            <ChatBubble>
              <div className="space-y-1">
                <div className="bg-orange-100 h-[1em] w-[200px]" />
                <div className="bg-orange-100 h-[1em] w-[150px]" />
              </div>
            </ChatBubble>
          </div>
          <div
            className="absolute"
            style={{
              translate: "555px -59px",
              rotate: "21deg"
            }}
          >
            <ChatBubble>
              <div className="space-y-1">
                <div className="bg-orange-100 h-[1em] w-[200px]" />
                <div className="bg-orange-100 h-[1em] w-[150px]" />
              </div>
            </ChatBubble>
          </div>
          <div
            className="absolute"
            style={{
              translate: "-500px -68px",
              rotate: "333deg"
            }}
          >
            <ChatBubble>
              <div className="space-y-1">
                <div className="bg-orange-100 h-[1em] w-[200px]" />
                <div className="bg-orange-100 h-[1em] w-[150px]" />
              </div>
            </ChatBubble>
          </div>
        </div>
      </div>
    </div>
  );
}
