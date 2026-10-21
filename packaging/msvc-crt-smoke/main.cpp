#include <string>
extern int model_text_size();
int main() { return model_text_size() == static_cast<int>(std::string("model").size()) ? 0 : 1; }
