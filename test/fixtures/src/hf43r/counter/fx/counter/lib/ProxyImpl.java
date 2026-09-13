package fx.counter.lib;
import java.util.ServiceLoader;
public interface ProxyImpl {
  ProxyImpl INSTANCE = ServiceLoader.load(ProxyImpl.class).findFirst().orElseThrow();
  static ProxyImpl get() { return INSTANCE; }
  ModCtorImpl getModCtor();
}
