/** biome-ignore-all lint/correctness/useUniqueElementIds: it's fine */
/** biome-ignore-all lint/a11y/noStaticElementInteractions: it's fine */
interface HeaderProps {
  onSetCodeVisible: (visible: boolean) => void;
}

const Header = ({ onSetCodeVisible }: HeaderProps) => {
  return (
    <div className="md:flex py-5 hidden">
      <a
        className="hover:bg-gray-50 text-sm cursor-pointer font-sm px-3 py-2 bg-white border border-gray-200 rounded-md shadow-sm ml-auto mr-3 flex items-center"
        href="https://developers.cloudflare.com/workers-ai/"
        target="_blank"
        rel="noreferrer"
      >
        Docs
        <svg
          className="ml-1"
          width="19"
          height="19"
          viewBox="0 0 19 19"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>Cloudflare Logo</title>
          <path
            d="M14.5625 5.98437L11.1875 5.98437V7.10937L14.5625 7.10937V5.98437Z"
            fill="url(#paint0_linear_1036_7741)"
          />
          <path
            d="M11.1875 8.23438L14.5625 8.23437V9.35937L11.1875 9.35938V8.23438Z"
            fill="url(#paint1_linear_1036_7741)"
          />
          <path
            d="M14.5625 10.4844L11.1875 10.4844V11.6094H14.5625V10.4844Z"
            fill="url(#paint2_linear_1036_7741)"
          />
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M2.75 3.03125L2.1875 3.59375L2.1875 15.4062L2.75 15.9688H7.25C7.87461 15.9688 8.41997 16.3081 8.71174 16.8125H10.2883C10.58 16.3081 11.1254 15.9687 11.75 15.9687H16.25L16.8125 15.4062V3.59375L16.25 3.03125L11.75 3.03125C10.83 3.03125 10.0131 3.47301 9.5 4.15598C8.98687 3.47301 8.17002 3.03125 7.25 3.03125L2.75 3.03125ZM8.9375 5.84375C8.9375 4.91177 8.18198 4.15625 7.25 4.15625L3.3125 4.15625L3.3125 14.8438H7.25C7.88315 14.8438 8.46744 15.053 8.9375 15.406L8.9375 5.84375ZM10.0625 15.406C10.5326 15.053 11.1168 14.8437 11.75 14.8437H15.6875L15.6875 4.15625L11.75 4.15625C10.818 4.15625 10.0625 4.91177 10.0625 5.84375L10.0625 15.406Z"
            fill="url(#paint3_linear_1036_7741)"
          />
          <defs>
            <linearGradient
              id="paint0_linear_1036_7741"
              x1="2.1875"
              y1="11.4087"
              x2="16.7051"
              y2="7.22872"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#901475" />
              <stop offset="0.505208" stopColor="#CE2F55" />
              <stop offset="1" stopColor="#FF6633" />
            </linearGradient>
            <linearGradient
              id="paint1_linear_1036_7741"
              x1="2.1875"
              y1="11.4087"
              x2="16.7051"
              y2="7.22872"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#901475" />
              <stop offset="0.505208" stopColor="#CE2F55" />
              <stop offset="1" stopColor="#FF6633" />
            </linearGradient>
            <linearGradient
              id="paint2_linear_1036_7741"
              x1="2.1875"
              y1="11.4087"
              x2="16.7051"
              y2="7.22872"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#901475" />
              <stop offset="0.505208" stopColor="#CE2F55" />
              <stop offset="1" stopColor="#FF6633" />
            </linearGradient>
            <linearGradient
              id="paint3_linear_1036_7741"
              x1="2.1875"
              y1="11.4087"
              x2="16.7051"
              y2="7.22872"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#901475" />
              <stop offset="0.505208" stopColor="#CE2F55" />
              <stop offset="1" stopColor="#FF6633" />
            </linearGradient>
          </defs>
        </svg>
      </a>
      <a
        className="hover:bg-gray-50 text-sm cursor-pointer font-sm px-3 py-2 bg-white border border-gray-200 rounded-md shadow-sm mr-3 flex items-center"
        // biome-ignore lint/a11y/useValidAnchor: it's fine
        onClick={() => onSetCodeVisible(true)}
      >
        View Code
        <svg
          className="ml-1"
          width="19"
          height="19"
          viewBox="0 0 19 19"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>View Code</title>
          <path
            d="M14.6779 2.1875L4.32227 2.1875L3.75977 2.75L3.75977 16.25L4.32227 16.8125H14.6779L15.2404 16.25L15.2404 2.75L14.6779 2.1875ZM14.1154 15.6875L4.88477 15.6875L4.88477 3.3125L14.1154 3.3125L14.1154 15.6875Z"
            fill="url(#paint0_linear_1036_7744)"
          />
          <path
            d="M6.6257 10.7459L6.6257 11.435C6.61787 11.6903 6.65695 11.9448 6.74102 12.1859C6.8093 12.3661 6.92612 12.5238 7.07852 12.6416C7.24093 12.7557 7.42609 12.8334 7.62133 12.8694C7.86158 12.9135 8.10553 12.9342 8.34976 12.9313V12.1803C8.18087 12.19 8.01211 12.1591 7.85758 12.0903C7.80185 12.0614 7.75247 12.0216 7.71238 11.9733C7.67228 11.925 7.64228 11.8692 7.62414 11.8091C7.57719 11.659 7.55533 11.5022 7.55945 11.345L7.55945 10.4675C7.56084 10.3348 7.53697 10.2031 7.48914 10.0794C7.43554 9.94983 7.3457 9.8385 7.23039 9.75875C7.06543 9.65218 6.88091 9.57951 6.68758 9.545H6.6482V9.44094H6.68758C6.88153 9.40384 7.0661 9.3283 7.23039 9.21875C7.3457 9.139 7.43554 9.02767 7.48914 8.89813C7.53726 8.77348 7.56112 8.64079 7.55945 8.50719L7.55945 7.61562C7.55533 7.45843 7.57719 7.30164 7.62414 7.15156C7.64228 7.09146 7.67228 7.03561 7.71238 6.9873C7.75247 6.93899 7.80185 6.89921 7.85758 6.87031C8.0128 6.80395 8.18119 6.77412 8.34976 6.78312V6.04063C8.10538 6.03713 7.86128 6.05881 7.62133 6.10531C7.42593 6.1391 7.24051 6.21596 7.07852 6.33031C6.92612 6.44812 6.8093 6.60582 6.74102 6.78594C6.65782 7.02536 6.61875 7.27788 6.6257 7.53125L6.6257 8.22312C6.64762 8.44357 6.58196 8.6638 6.44289 8.83625C6.35336 8.90887 6.2504 8.96314 6.13989 8.99596C6.02938 9.02877 5.91348 9.03949 5.79883 9.0275V9.93875C6.03 9.91375 6.26165 9.98152 6.44289 10.1272C6.58339 10.3011 6.64914 10.5236 6.6257 10.7459Z"
            fill="url(#paint1_linear_1036_7744)"
          />
          <path
            d="M11.9216 12.6416C12.074 12.5238 12.1909 12.3661 12.2591 12.1859C12.3432 11.9448 12.3823 11.6903 12.3745 11.435V10.7459C12.3525 10.5255 12.4182 10.3053 12.5573 10.1328C12.6469 10.0604 12.7499 10.0065 12.8604 9.97415C12.971 9.9418 13.0868 9.93168 13.2013 9.94438L13.2013 9.03312C13.0867 9.04543 12.9707 9.03486 12.8601 9.00203C12.7496 8.9692 12.6466 8.91477 12.5573 8.84188C12.4182 8.66943 12.3525 8.4492 12.3745 8.22875V7.53125C12.3821 7.276 12.343 7.02151 12.2591 6.78031C12.1909 6.6002 12.074 6.4425 11.9216 6.32469C11.7596 6.21033 11.5742 6.13347 11.3788 6.09969C11.1389 6.05318 10.8948 6.0315 10.6504 6.035V6.78875C10.819 6.77975 10.9874 6.80958 11.1426 6.87594C11.1983 6.90484 11.2477 6.94462 11.2878 6.99292C11.3279 7.04123 11.3579 7.09709 11.376 7.15719C11.423 7.30726 11.4448 7.46406 11.4407 7.62125V8.51C11.439 8.6436 11.4629 8.77629 11.511 8.90094C11.5651 9.02945 11.6549 9.13976 11.7698 9.21875C11.9313 9.32396 12.1119 9.39657 12.3013 9.4325H12.3407L12.3407 9.53656H12.3013C12.1119 9.57249 11.9313 9.6451 11.7698 9.75031C11.6545 9.83006 11.5646 9.94139 11.511 10.0709C11.4632 10.1947 11.4393 10.3264 11.4407 10.4591V11.3562C11.4448 11.5134 11.423 11.6702 11.376 11.8203C11.3579 11.8804 11.3279 11.9363 11.2878 11.9846C11.2477 12.0329 11.1983 12.0727 11.1426 12.1016C10.988 12.1704 10.8193 12.2013 10.6504 12.1916V12.9313C10.8944 12.936 11.1384 12.9172 11.3788 12.875C11.5745 12.8373 11.7597 12.7577 11.9216 12.6416Z"
            fill="url(#paint2_linear_1036_7744)"
          />
          <defs>
            <linearGradient
              id="paint0_linear_1036_7744"
              x1="3.75977"
              y1="11.0779"
              x2="15.5653"
              y2="8.56351"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#901475" />
              <stop offset="0.505208" stopColor="#CE2F55" />
              <stop offset="1" stopColor="#FF6633" />
            </linearGradient>
            <linearGradient
              id="paint1_linear_1036_7744"
              x1="3.75977"
              y1="11.0779"
              x2="15.5653"
              y2="8.56351"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#901475" />
              <stop offset="0.505208" stopColor="#CE2F55" />
              <stop offset="1" stopColor="#FF6633" />
            </linearGradient>
            <linearGradient
              id="paint2_linear_1036_7744"
              x1="3.75977"
              y1="11.0779"
              x2="15.5653"
              y2="8.56351"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#901475" />
              <stop offset="0.505208" stopColor="#CE2F55" />
              <stop offset="1" stopColor="#FF6633" />
            </linearGradient>
          </defs>
        </svg>
      </a>
      <a
        className="hover:bg-gray-50 text-sm cursor-pointer font-sm px-3 py-2 bg-white border border-gray-200 rounded-md shadow-sm flex items-center"
        href="https://github.com/cloudflare/agents/tree/main/examples/ai-playground"
        target="_blank"
        rel="noreferrer"
      >
        GitHub
        <svg
          className="ml-1.5"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          xmlns="http://www.w3.org/2000/svg"
        >
          <title>GitHub</title>
          <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
        </svg>
      </a>
    </div>
  );
};

export default Header;
