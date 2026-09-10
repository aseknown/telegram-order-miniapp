export function createRequestScope() {
  let generation=0;
  let controller=new AbortController();
  return {
    begin() {controller.abort(); controller=new AbortController(); return ++generation;},
    current(value) {return value===generation;},
    capture() {const version=generation; return {signal:controller.signal,assertCurrent() {if(version!==generation) throw new DOMException('View changed','AbortError');}};}
  };
}
