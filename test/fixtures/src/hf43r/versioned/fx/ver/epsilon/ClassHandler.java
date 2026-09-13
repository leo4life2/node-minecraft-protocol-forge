package fx.ver.epsilon;
import fx.ver.lib.ClassNamedPacketType;
public final class ClassHandler<T> implements ClassNamedPacketType<T> {
  private final Class<T> clazz;
  public ClassHandler(Class<T> clazz) { this.clazz = clazz; }
  public Class<T> clazz() { return this.clazz; }
}
