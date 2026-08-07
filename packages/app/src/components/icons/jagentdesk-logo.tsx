import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";

interface JAgentDeskLogoProps {
  size?: number;
  color?: string;
}

/** The JAgentDesk mark. Kept as native SVG so desktop, iOS, Android and web use one asset. */
export function JAgentDeskLogo({ size = 64, color }: JAgentDeskLogoProps) {
  const { theme } = useUnistyles();

  return (
    <Svg width={size} height={size} viewBox="0 0 1024 1024" fill="none">
      <Defs>
        <LinearGradient id="jagentdesk-logo-gradient" x1="232" y1="142" x2="682" y2="836" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#13C8F2" />
          <Stop offset="0.52" stopColor="#176BFF" />
          <Stop offset="1" stopColor="#7A4DFF" />
        </LinearGradient>
        <LinearGradient id="jagentdesk-logo-gradient-dark" x1="270" y1="284" x2="585" y2="844" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={color ?? theme.colors.foreground} />
          <Stop offset="1" stopColor={color ?? theme.colors.foreground} stopOpacity="0.72" />
        </LinearGradient>
      </Defs>
      <Path
        d="M390 214L512 142L682 242V754L548 836V356L454 410V706C454 779 410 830 342 830C275 830 232 789 232 727V658H322V716C322 741 334 754 354 754C378 754 390 738 390 708V214Z"
        fill="url(#jagentdesk-logo-gradient)"
      />
      <Path
        d="M500 334L585 284V680C585 779 525 844 426 844C330 844 270 786 270 691V616H366V683C366 729 389 752 427 752C473 752 500 724 500 672V334Z"
        fill="url(#jagentdesk-logo-gradient-dark)"
      />
    </Svg>
  );
}
