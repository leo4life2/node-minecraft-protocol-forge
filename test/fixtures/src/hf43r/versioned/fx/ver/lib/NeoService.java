package fx.ver.lib;
import net.minecraft.resources.Identifier;
public final class NeoService implements NetworkService { public Networking getNetwork(Identifier id, int version, boolean optional) { return new NeoNetworking(id, version, optional); } }
