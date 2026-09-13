package fx.ver.delta;
import fx.ver.lib.NeoNetworking;
import net.neoforged.fml.ModContainer; import net.neoforged.fml.common.Mod;
@Mod("delta")
public final class DeltaMod { public DeltaMod(ModContainer container) { container.getEventBus().addListener(NeoNetworking::setupNetwork); Handlers.init(); } }
