package fx.counter.lib;
import java.util.function.Supplier;
public interface ModInit {
  default void onConstruct() {}
  void onRegisterPayloadTypes(ServerCtx ctx);
  static void construct(String modId, Supplier<ModInit> supplier) { ProxyImpl.get().getModCtor().construct(modId, supplier.get()); }
}
