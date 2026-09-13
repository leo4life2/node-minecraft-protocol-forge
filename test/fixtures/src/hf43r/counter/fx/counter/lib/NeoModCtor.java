package fx.counter.lib;
import java.util.Map; import java.util.Optional; import java.util.concurrent.ConcurrentHashMap;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.network.event.RegisterPayloadHandlersEvent;
public final class NeoModCtor implements ModCtorImpl {
  private static final Map<String, IEventBus> BUSES = new ConcurrentHashMap<>();
  private static Optional<IEventBus> getOptionalModEventBus(String modId) { return Optional.ofNullable(BUSES.get(modId)); }
  public void construct(String modId, ModInit init) {
    getOptionalModEventBus(modId).ifPresent((IEventBus bus) -> {
      init.onConstruct();
      bus.addListener((RegisterPayloadHandlersEvent event) -> {
        ServerCtx ctx = new ServerCtx(modId, event);
        init.onRegisterPayloadTypes(ctx);
      });
    });
  }
}
