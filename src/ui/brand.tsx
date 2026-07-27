/**
 * The mark.
 *
 * This file used to hold three things: the mark, an ambient background wash,
 * and a gradient-filled disc used for the send button. The wash and the disc
 * are gone. Both were pulling the interface away from the reference, which has
 * a flat ground and a monochrome send affordance — an ambient glow behind a
 * conversation is exactly the kind of atmosphere that reads as styling rather
 * than as design once you put it next to something disciplined.
 *
 * What survives is the one element whose job is to be recognised rather than
 * read, and it keeps the gradient for that reason.
 */

import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Path,
  Stop,
} from 'react-native-svg';
import { useTheme } from './theme';

/**
 * The OfflineAI mark.
 *
 * A ring with an inward spiral: the ring is the device boundary that nothing
 * crosses, and the spiral is the reasoning happening inside it. It reads at
 * 17pt (beside a message) and at 64pt (the empty state) without a second
 * artwork, which is the only real test a mark has to pass.
 *
 * Drawn as vector rather than shipped as a raster so it stays crisp at every
 * size and takes its colours from the live theme instead of needing a variant
 * per appearance.
 */
export function Mark({
  size = 28,
  style,
}: {
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const [from, to] = theme.gradient;
  // A shared id is safe here: two gradient definitions with the same id and
  // identical stops resolve to the same paint, and every Mark in the app uses
  // the same two stops.
  const gradientId = 'offlineai-mark';

  return (
    <View style={style}>
      <Svg width={size} height={size} viewBox="0 0 48 48" fill="none">
        <Defs>
          <SvgLinearGradient id={gradientId} x1="6" y1="4" x2="42" y2="44">
            <Stop offset="0" stopColor={from} />
            <Stop offset="1" stopColor={to} />
          </SvgLinearGradient>
        </Defs>

        {/* The boundary. Open at the top-right so the ring reads as drawn
            rather than as a border. */}
        <Path
          d="M35.5 8.6A20 20 0 1 0 44 24"
          stroke={`url(#${gradientId})`}
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
        />
        {/* The reasoning inside it. */}
        <Path
          d="M24 34a10 10 0 1 1 10-10"
          stroke={`url(#${gradientId})`}
          strokeWidth={4}
          strokeLinecap="round"
          fill="none"
          opacity={0.75}
        />
        <Circle cx="24" cy="24" r="3.4" fill={`url(#${gradientId})`} />
      </Svg>
    </View>
  );
}
