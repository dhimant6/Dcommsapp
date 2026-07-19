import { NavigationContainer } from '@react-navigation/native';
import { RootNavigator } from './src/navigation/RootNavigator';

/**
 * App root. Deliberately thin: navigation decides auth vs main flow by
 * subscribing to the Zustand auth store â€” no prop drilling, no context towers.
 */
export default function App() {
  return (
    <NavigationContainer>
      <RootNavigator />
    </NavigationContainer>
  );
}

