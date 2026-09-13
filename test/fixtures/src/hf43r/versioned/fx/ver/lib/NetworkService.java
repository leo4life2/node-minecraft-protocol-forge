package fx.ver.lib;
import java.util.ServiceLoader;
import net.minecraft.resources.Identifier;
public interface NetworkService {
  Networking getNetwork(Identifier id, int version, boolean optional);
  static NetworkService create() { return ServiceLoader.load(NetworkService.class).findFirst().orElseThrow(); }
}
