package fx.counter.alpha;
import fx.counter.lib.ModInit;
import net.neoforged.fml.ModContainer; import net.neoforged.fml.common.Mod;
@Mod("alpha")
public final class AlphaMod { public AlphaMod(ModContainer container) { ModInit.construct("alpha", Alpha::new); } }
